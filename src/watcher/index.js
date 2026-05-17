const { collections } = require('../db');
const config = require('../config');
const logger = require('../logger');
const bsc = require('./bsc');
const tron = require('./tron');

let shouldStop = false;
let currentBackoffMs = 0;

function stop() { shouldStop = true; }

// MUST match the normalization in src/routes/payments.js exactly.
// ethers.formatUnits returns strings like "5.0" from the chain parsers, but
// payments store the canonicalized form ("5"). Without this, the match query
// `{ amount: "5.0" }` against `{ amount: "5" }` fails, the deposit is never
// linked to its payment, and no webhook ever fires.
//
// TODO: extract to src/utils.js and import in both files so it can't drift.
function normalizeAmount(s) {
  if (s === null || s === undefined) return s;
  return parseFloat(s).toFixed(6).replace(/\.?0+$/, '');
}

async function tick() {
  await expirePastDuePayments();

  const activeUsers = await collections.users
    .find({
      $or: [
        { pending_payment_count: { $gt: 0 } },
        { unconfirmed_deposit_count: { $gt: 0 } },
      ],
    })
    .limit(200)
    .toArray();

  if (activeUsers.length === 0) return;

  const [bscCurrentBlock, tronCurrentBlock] = await Promise.all([
    bsc.getCurrentBlock().catch((e) => {
      logger.error({ err: e.message }, 'BSC getCurrentBlock failed');
      return null;
    }),
    tron.getCurrentBlock().catch((e) => {
      logger.error({ err: e.message }, 'Tron getCurrentBlock failed');
      return null;
    }),
  ]);

  if (bscCurrentBlock === null && tronCurrentBlock === null) {
    throw new Error('both RPCs failed');
  }

  for (const user of activeUsers) {
    if (shouldStop) return;
    await pollUser(user, { bscCurrentBlock, tronCurrentBlock }).catch((err) =>
      logger.error({ user_id: user.user_id, err: err.message }, 'poll user failed')
    );
  }

  if (bscCurrentBlock) await advanceConfirmations('bsc', bscCurrentBlock);
  if (tronCurrentBlock) await advanceConfirmations('tron', tronCurrentBlock);
}

async function pollUser(user, blocks) {
  if (blocks.bscCurrentBlock !== null) await pollBsc(user, blocks.bscCurrentBlock);
  if (blocks.tronCurrentBlock !== null) await pollTron(user, blocks.tronCurrentBlock);
}

async function pollBsc(user, currentBlock) {
  const { transfers } = await bsc.fetchIncomingTransfers(user.bsc_address, user.bsc_last_block);
  for (const t of transfers) {
    await recordDeposit({
      network: 'bsc', user, transfer: t, currentBlock,
      requiredConfirmations: config.bsc.confirmations,
    });
  }
  await collections.users.updateOne(
    { user_id: user.user_id },
    { $set: { bsc_last_block: currentBlock, updated_at: new Date() } }
  );
}

async function pollTron(user, currentBlock) {
  const { transfers } = await tron.fetchIncomingTransfers(user.tron_address, user.tron_last_block);
  for (const t of transfers) {
    await recordDeposit({
      network: 'tron', user, transfer: t, currentBlock,
      requiredConfirmations: config.tron.confirmations,
    });
  }
  await collections.users.updateOne(
    { user_id: user.user_id },
    { $set: { tron_last_block: currentBlock, updated_at: new Date() } }
  );
}

async function recordDeposit({ network, user, transfer, currentBlock, requiredConfirmations }) {
  const confirmations = transfer.block_number
    ? Math.max(0, currentBlock - transfer.block_number)
    : 0;
  const amount = normalizeAmount(transfer.amount); // ← FIX: canonicalize so match query succeeds
  const status = confirmations >= requiredConfirmations ? 'confirmed' : 'pending_confirmation';

  try {
    await collections.deposits.insertOne({
      network,
      tx_hash: transfer.tx_hash,
      user_id: user.user_id,
      address: transfer.to,
      from_address: transfer.from,
      amount,
      block_number: transfer.block_number,
      confirmations,
      status,
      matched_payment_id: null,
      seen_at: new Date(),
      confirmed_at: status === 'confirmed' ? new Date() : null,
    });
    logger.info({
      network, amount, user_id: user.user_id,
      tx: transfer.tx_hash.slice(0, 10),
    }, 'deposit seen');

    await tryMatchDeposit({
      network, user, tx_hash: transfer.tx_hash,
      amount, status, confirmations,
    });

    if (status === 'pending_confirmation') {
      await collections.users.updateOne(
        { user_id: user.user_id },
        { $inc: { unconfirmed_deposit_count: 1 } }
      );
    }
  } catch (err) {
    if (err.code === 11000) return; // dup tx — already recorded
    throw err;
  }
}

async function tryMatchDeposit({ network, user, tx_hash, amount, status, confirmations }) {
  // mongodb driver v6: findOneAndUpdate returns the doc directly (or null on no match),
  // NOT { value: doc, ... } as in v5. Don't read `.value` on the result.
  const matched = await collections.payments.findOneAndUpdate(
    {
      user_id: user.user_id,
      network,
      amount,
      status: 'pending',
      matched_tx_hash: null,
    },
    {
      $set: { matched_tx_hash: tx_hash, confirmations, updated_at: new Date() },
    },
    { sort: { created_at: 1 }, returnDocument: 'after' }
  );

  if (!matched || !matched.payment_id) return;

  await collections.deposits.updateOne(
    { network, tx_hash },
    { $set: { matched_payment_id: matched.payment_id } }
  );

  if (status === 'confirmed') {
    await terminalize(matched.payment_id, 'confirmed');
  } else {
    logger.info({ payment_id: matched.payment_id, tx: tx_hash.slice(0, 10) }, 'matched deposit');
  }
}

async function advanceConfirmations(network, currentBlock) {
  const threshold = network === 'bsc'
    ? config.bsc.confirmations
    : config.tron.confirmations;
  const deposits = await collections.deposits
    .find({ network, status: 'pending_confirmation' })
    .toArray();

  for (const d of deposits) {
    if (!d.block_number) continue;
    const confs = Math.max(0, currentBlock - d.block_number);
    if (confs >= threshold) {
      await collections.deposits.updateOne(
        { network, tx_hash: d.tx_hash },
        { $set: { status: 'confirmed', confirmations: confs, confirmed_at: new Date() } }
      );
      await collections.users.updateOne(
        { user_id: d.user_id },
        { $inc: { unconfirmed_deposit_count: -1 } }
      );
      if (d.matched_payment_id) await terminalize(d.matched_payment_id, 'confirmed');
    } else {
      await collections.deposits.updateOne(
        { network, tx_hash: d.tx_hash },
        { $set: { confirmations: confs } }
      );
      if (d.matched_payment_id) {
        await collections.payments.updateOne(
          { payment_id: d.matched_payment_id },
          { $set: { confirmations: confs, updated_at: new Date() } }
        );
      }
    }
  }
}

async function terminalize(paymentId, event) {
  // mongodb driver v6: returns the doc directly (or null), not { value: doc }
  const p = await collections.payments.findOneAndUpdate(
    { payment_id: paymentId, status: 'pending' },
    {
      $set: {
        status: 'terminal',
        terminal_event: event,
        next_webhook_at: Date.now(),
        updated_at: new Date(),
      },
    },
    { returnDocument: 'after' }
  );
  if (!p || !p.payment_id) return;

  await collections.users.updateOne(
    { user_id: p.user_id },
    { $inc: { pending_payment_count: -1 } }
  );
  logger.info({ payment_id: paymentId, event }, 'payment terminalized');
}

async function expirePastDuePayments() {
  const expired = await collections.payments
    .find({ status: 'pending', expires_at: { $lt: Date.now() }, matched_tx_hash: null })
    .toArray();
  for (const p of expired) await terminalize(p.payment_id, 'expired');
}

async function start() {
  logger.info({ intervalMs: config.watcher.intervalMs }, 'watcher started');
  while (!shouldStop) {
    try {
      await tick();
      currentBackoffMs = 0;
    } catch (err) {
      currentBackoffMs = Math.min(
        currentBackoffMs ? currentBackoffMs * 2 : config.watcher.intervalMs,
        config.watcher.maxBackoffMs
      );
      logger.error({ err: err.message, backoffMs: currentBackoffMs }, 'watcher tick error');
    }
    const sleep = currentBackoffMs || config.watcher.intervalMs;
    const jittered = sleep * (0.9 + Math.random() * 0.2);
    await new Promise((r) => setTimeout(r, jittered));
  }
  logger.info('watcher stopped');
}

module.exports = { start, stop, tick };