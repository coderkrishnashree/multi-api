const express = require('express');
const { collections, ping } = require('../db');

const router = express.Router();
const startedAt = Date.now();

// Liveness — does the process respond? No external deps touched.
router.get('/health/live', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// Readiness — is the process ready to serve traffic? Touches Mongo.
router.get('/health/ready', async (req, res) => {
  const mongoOk = await ping();
  if (!mongoOk) {
    return res.status(503).json({ status: 'not_ready', mongo: false });
  }
  res.json({ status: 'ok', mongo: true });
});

// Full report — for ops dashboards. Heavier; not for healthchecks.
router.get('/health', async (req, res) => {
  try {
    const [users, pendingPayments, terminalPayments, queuedWebhooks, deposits] = await Promise.all([
      collections.users.countDocuments({}),
      collections.payments.countDocuments({ status: 'pending' }),
      collections.payments.countDocuments({ status: 'terminal' }),
      collections.payments.countDocuments({
        status: 'terminal',
        webhook_status: { $in: ['not_sent', 'sending'] },
      }),
      collections.deposits.countDocuments({}),
    ]);

    res.json({
      status: 'ok',
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      users,
      payments: { pending: pendingPayments, terminal: terminalPayments },
      webhooks_queued: queuedWebhooks,
      deposits,
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;