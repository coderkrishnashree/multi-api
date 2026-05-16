const { collections } = require('../db');
const config = require('../config');
const bsc = require('./bsc');
const tron = require('./tron');

/**
 * One tick of the watcher:
 *  1. Find users who have pending payments or unconfirmed deposits.
 *  2. For each, poll Tron + BSC for new incoming transfers.
 *  3. Record new deposits (idempotent on tx_hash).
 *  4. Match deposits to pending payments.
 *  5. Bump confirmation counts; mark confirmed when threshold hit.
 *  6. Expire payments past their expiration timestamp.
 */
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

  // Fetch current block once per network
  const [bscCurrentBlock, tronCurrentBlock] = await Promise.all([
    bsc.getCurrentBlock().catch((e) => {
      console.error('BSC getCurrentBlock failed:', e.message);
      return null;
    }),
    tron.getCurrentBlock().catch((e) => {
      console.error('Tron getCurrentBlock failed:', e.message);
      return null;
    }),
  ]);

  for (const user of activeUsers) {
    await pollUser(user, { bscCurrentBlock, tronCurrentBlock }).catch((err) =>
      console.error(`poll user ${user.user_id} failed:`, err.message)
    );
  }

  // Confirmation pass: bump confirmations on existing pending_confirmation deposits
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
      network: 'bsc',
      user,
      transfer: t,
      currentBlock,
      decimalsConfirmations: config.bsc.confirmations,
    });
  }
  // Advance last_block cursor
  await collections.users.updateOne(
    { user_id: user.user_id },
    { $set: { bsc_last_block: currentBlock, updated_at: new Date() } }
  );
}

async function pollTron(user, currentBlock) {
  const { transfers } = await tron.fetchIncomingTransfers(
    user.tron_address,
    user.tron_last_block
  );
  for (const t of transfers) {
    await recordDeposit({
      network: 'tron',
      user,
      transfer: t,
      currentBlock,
      decimalsConfirmations: config.tron.confirmations,
    });
  }
  await collections.users.updateOne(
    { user_id: user.user_id },
    { $set: { tron_last_block: currentBlock, updated_at: new Date() } }
  );
}

async function recordDeposit({ network, user, transfer, currentBlock, decimalsConfirmations }) {
  const confirmations = transfer.block_number
    ? Math.max(0, currentBlock - transfer.block_number)
    : 0;
  const status = confirmations >= decimalsConfirmations ? 'confirmed' : 'pending_confirmation';

  try {
    const result = await collections.deposits.insertOne({
      network,
      tx_hash: transfer.tx_hash,
      user_id: user.user_id,
      address: transfer.to,
      from_address: transfer.from,
      amount: transfer.amount,
      block_number: transfer.block_number,
      confirmations,
      status,
      matched_payment_id: null,
      seen_at: new Date(),
      confirmed_at: status === 'confirmed' ? new Date() : null,
    });
    console.log(`💸 deposit seen [${network}] ${transfer.amount} USDT → ${user.user_id} (tx ${transfer.tx_hash.slice(0, 10)}…)`);

    // Try to match a pending payment
    await tryMatchDeposit({ network, user, tx_hash: transfer.tx_hash, amount: transfer.amount, status, confirmations });

    if (status === 'pending_confirmation') {
      await collections.users.updateOne(
        { user_id: user.user_id },
        { $inc: { unconfirmed_deposit_count: 1 } }
      );
    }
  } catch (err) {
    // Duplicate key = we've seen this tx already; ignore
    if (err.code === 11000) return;
    throw err;
  }
}

/**
 * Match an incoming deposit to a pending payment for the same user, network, and amount.
 * Strategy: oldest pending payment with matching amount wins.
 */
async function tryMatchDeposit({ network, user, tx_hash, amount, status, confirmations }) {
  const payment = await collections.payments.findOneAndUpdate(
    {
      user_id: user.user_id,
      network,
      amount,
      status: 'pending',
      matched_tx_hash: null,
    },
    {
      $set: {
        matched_tx_hash: tx_hash,
        confirmations,
        updated_at: new Date(),
      },
    },
    { sort: { created_at: 1 }, returnDocument: 'after' }
  );

  const matched = payment.value || payment;
  if (!matched) return;

  await collections.deposits.updateOne(
    { network, tx_hash },
    { $set: { matched_payment_id: matched.payment_id } }
  );

  // If already confirmed at intake, terminalize immediately
  if (status === 'confirmed') {
    await terminalize(matched.payment_id, 'confirmed');
  } else {
    console.log(`🔗 matched payment ${matched.payment_id} ← deposit ${tx_hash.slice(0, 10)}…`);
  }
}

/**
 * Walk through pending_confirmation deposits and bump their confirmation counts.
 * When a deposit reaches the threshold, mark its matched payment confirmed.
 */
async function advanceConfirmations(network, currentBlock) {
  const threshold = network === 'bsc' ? config.bsc.confirmations : config.tron.confirmations;

  const deposits = await collections.deposits
    .find({ network, status: 'pending_confirmation' })
    .toArray();

  for (const d of deposits) {
    if (!d.block_number) continue;
    const confs = Math.max(0, currentBlock - d.block_number);
    if (confs >= threshold) {
      await collections.deposits.updateOne(
        { network, tx_hash: d.tx_hash },
        {
          $set: { status: 'confirmed', confirmations: confs, confirmed_at: new Date() },
        }
      );
      await collections.users.updateOne(
        { user_id: d.user_id },
        { $inc: { unconfirmed_deposit_count: -1 } }
      );
      if (d.matched_payment_id) {
        await terminalize(d.matched_payment_id, 'confirmed');
      }
    } else {
      await collections.deposits.updateOne(
        { network, tx_hash: d.tx_hash },
        { $set: { confirmations: confs } }
      );
      // Keep the matched payment's confirmation count in sync
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
  const updated = await collections.payments.findOneAndUpdate(
    { payment_id: paymentId, status: 'pending' },
    {
      $set: {
        status: 'terminal',
        terminal_event: event,
        next_webhook_at: Date.now(), // queue webhook immediately
        updated_at: new Date(),
      },
    },
    { returnDocument: 'after' }
  );
  const p = updated.value || updated;
  if (!p) return;

  await collections.users.updateOne(
    { user_id: p.user_id },
    { $inc: { pending_payment_count: -1 } }
  );

  console.log(`📦 payment ${paymentId} → ${event}`);
}

async function expirePastDuePayments() {
  const expired = await collections.payments
    .find({ status: 'pending', expires_at: { $lt: Date.now() }, matched_tx_hash: null })
    .toArray();

  for (const p of expired) {
    await terminalize(p.payment_id, 'expired');
  }
}

/**
 * Run the watcher loop forever. Stagger from the webhook loop with a small offset.
 */
async function start() {
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error('watcher tick error:', err.message);
    }
    await new Promise((r) => setTimeout(r, config.watcher.intervalMs));
  }
}

module.exports = { start, tick };