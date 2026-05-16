const express = require('express');
const { v4: uuid } = require('uuid');
const { collections } = require('../db');
const config = require('../config');

const router = express.Router();

const SUPPORTED_NETWORKS = ['tron', 'bsc'];

function networkLabel(network) {
  return network === 'tron' ? 'TRC20 (Tron)' : 'BEP20 (BSC)';
}

function addressForNetwork(user, network) {
  return network === 'tron' ? user.tron_address : user.bsc_address;
}

// POST /v1/payments — create a payment for a user
// body: { user_id, network, amount, order_id, webhook_url?, expires_in_minutes? }
router.post('/v1/payments', async (req, res) => {
  try {
    const {
      user_id,
      network,
      amount,
      order_id,
      webhook_url,
      expires_in_minutes,
    } = req.body;

    if (!user_id) return res.status(400).json({ error: 'invalid_user_id', message: 'user_id required' });
    if (!SUPPORTED_NETWORKS.includes(network)) {
      return res.status(400).json({
        error: 'invalid_network',
        message: `network must be one of: ${SUPPORTED_NETWORKS.join(', ')}`,
      });
    }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'invalid_amount', message: 'amount must be a positive number string' });
    }
    if (!order_id) return res.status(400).json({ error: 'invalid_order_id', message: 'order_id required' });
    if (webhook_url && !/^https?:\/\//.test(webhook_url)) {
      return res.status(400).json({ error: 'invalid_webhook_url', message: 'webhook_url must be http(s)' });
    }

    const user = await collections.users.findOne({ user_id });
    if (!user) {
      return res.status(404).json({
        error: 'user_not_found',
        message: 'Create the user first via POST /v1/users',
      });
    }

    // Normalize amount to a fixed string — we'll match deposits on exact equality
    const normalizedAmount = parseFloat(amount).toFixed(6).replace(/\.?0+$/, '');

    // Optional: reject duplicate-amount pending payment for this user+network
    const conflict = await collections.payments.findOne({
      user_id,
      network,
      amount: normalizedAmount,
      status: 'pending',
    });
    if (conflict) {
      return res.status(409).json({
        error: 'duplicate_pending_amount',
        message: `User already has a pending ${network} payment for ${normalizedAmount} USDT`,
        existing_payment_id: conflict.payment_id,
      });
    }

    const paymentId = `pay_${uuid().replace(/-/g, '')}`;
    const expirationMin = expires_in_minutes || config.payments.defaultExpirationMin;
    const expiresAt = Date.now() + expirationMin * 60 * 1000;
    const address = addressForNetwork(user, network);

    await collections.payments.insertOne({
      payment_id: paymentId,
      user_id,
      order_id,
      network,
      amount: normalizedAmount,
      address,
      status: 'pending',
      terminal_event: null,
      matched_tx_hash: null,
      confirmations: 0,
      expires_at: expiresAt,
      webhook_url: webhook_url || null,
      webhook_status: webhook_url ? 'not_sent' : 'not_applicable',
      delivery_attempts: 0,
      next_webhook_at: null,
      last_error: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    await collections.users.updateOne(
      { user_id },
      { $inc: { pending_payment_count: 1 }, $set: { updated_at: new Date() } }
    );

    res.status(201).json({
      payment_id: paymentId,
      user_id,
      order_id,
      network,
      network_label: networkLabel(network),
      amount: normalizedAmount,
      address,
      status: 'pending',
      expires_at: new Date(expiresAt).toISOString(),
    });
  } catch (err) {
    console.error('createPayment error:', err.message);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /v1/payments/:id
router.get('/v1/payments/:id', async (req, res) => {
  try {
    const p = await collections.payments.findOne({ payment_id: req.params.id });
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json(serialize(p));
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /v1/payments?user_id=&status=&limit=
router.get('/v1/payments', async (req, res) => {
  try {
    const { user_id, status, limit } = req.query;
    const q = {};
    if (user_id) q.user_id = user_id;
    if (status) q.status = status;

    const list = await collections.payments
      .find(q)
      .sort({ created_at: -1 })
      .limit(Math.min(parseInt(limit || '50', 10), 200))
      .toArray();

    res.json({ payments: list.map(serialize) });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// POST /v1/payments/:id/replay-webhook
router.post('/v1/payments/:id/replay-webhook', async (req, res) => {
  try {
    const p = await collections.payments.findOne({ payment_id: req.params.id });
    if (!p) return res.status(404).json({ error: 'not_found' });
    if (p.status !== 'terminal') {
      return res.status(409).json({ error: 'not_terminal', message: 'Payment is still pending' });
    }
    if (!p.webhook_url) {
      return res.status(400).json({ error: 'no_webhook', message: 'Payment has no webhook_url' });
    }
    await collections.payments.updateOne(
      { payment_id: p.payment_id },
      {
        $set: {
          webhook_status: 'not_sent',
          next_webhook_at: Date.now(),
          delivery_attempts: 0,
          last_error: null,
          updated_at: new Date(),
        },
      }
    );
    res.json({ status: 'queued' });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

function serialize(p) {
  let outwardStatus = p.status;
  if (p.status === 'terminal') outwardStatus = p.terminal_event; // 'confirmed' | 'expired'
  if (p.status === 'pending' && p.matched_tx_hash) outwardStatus = 'received';
  return {
    payment_id: p.payment_id,
    user_id: p.user_id,
    order_id: p.order_id,
    network: p.network,
    network_label: networkLabel(p.network),
    amount: p.amount,
    address: p.address,
    status: outwardStatus,
    confirmations: p.confirmations || 0,
    tx_hash: p.matched_tx_hash || null,
    expires_at: new Date(p.expires_at).toISOString(),
    created_at: p.created_at,
  };
}

module.exports = router;