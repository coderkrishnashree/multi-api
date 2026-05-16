const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');
const { collections } = require('./db');

function signPayload(payload) {
  if (!config.webhookSecret) return null;
  return crypto
    .createHmac('sha256', config.webhookSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

function buildPayload(payment) {
  return {
    event: payment.terminal_event === 'confirmed'
      ? 'payment.confirmed'
      : 'payment.expired',
    payment_id: payment.payment_id,
    user_id: payment.user_id,
    order_id: payment.order_id,
    network: payment.network,
    amount: payment.amount,
    address: payment.address,
    tx_hash: payment.matched_tx_hash || null,
    timestamp: new Date().toISOString(),
  };
}

async function deliverWebhook(payment) {
  const claimed = await collections.payments.findOneAndUpdate(
    {
      payment_id: payment.payment_id,
      webhook_status: { $in: ['not_sent', 'sending'] },
    },
    { $set: { webhook_status: 'sending', updated_at: new Date() } },
    { returnDocument: 'after' }
  );
  const r = claimed.value || claimed;
  if (!r) return;

  const payload = buildPayload(r);
  const signature = signPayload(payload);

  try {
    await axios.post(r.webhook_url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-Id': r.payment_id,
        ...(signature && { 'X-Signature': signature }),
      },
      timeout: config.webhooks.timeoutMs,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    await collections.payments.updateOne(
      { payment_id: r.payment_id },
      {
        $set: {
          webhook_status: 'delivered',
          next_webhook_at: null,
          delivery_attempts: (r.delivery_attempts || 0) + 1,
          last_error: null,
          updated_at: new Date(),
        },
      }
    );
    console.log(`✅ webhook delivered: ${r.payment_id} (${payload.event})`);
  } catch (err) {
    const attempts = (r.delivery_attempts || 0) + 1;
    if (attempts >= config.webhooks.maxAttempts) {
      await collections.payments.updateOne(
        { payment_id: r.payment_id },
        {
          $set: {
            webhook_status: 'failed',
            next_webhook_at: null,
            delivery_attempts: attempts,
            last_error: err.message,
            updated_at: new Date(),
          },
        }
      );
      console.error(`💀 webhook permanently failed: ${r.payment_id} after ${attempts}`);
    } else {
      const backoff = 30000 * Math.pow(2, attempts - 1);
      await collections.payments.updateOne(
        { payment_id: r.payment_id },
        {
          $set: {
            webhook_status: 'not_sent',
            next_webhook_at: Date.now() + backoff,
            delivery_attempts: attempts,
            last_error: err.message,
            updated_at: new Date(),
          },
        }
      );
      console.warn(`⚠️  webhook ${r.payment_id} attempt ${attempts} failed; retry in ${Math.round(backoff / 1000)}s`);
    }
  }
}

async function tickWebhooks() {
  const due = await collections.payments
    .find({
      status: 'terminal',
      webhook_status: { $in: ['not_sent', 'sending'] },
      next_webhook_at: { $ne: null, $lte: Date.now() },
    })
    .limit(20)
    .toArray();

  for (const p of due) {
    await deliverWebhook(p).catch((err) =>
      console.error(`webhook tick failed for ${p.payment_id}:`, err.message)
    );
  }
}

module.exports = { tickWebhooks, deliverWebhook };