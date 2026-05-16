const express = require('express');
const { collections } = require('../db');

const router = express.Router();

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