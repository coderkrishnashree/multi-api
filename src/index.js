const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const watcher = require('./watcher');
const { tickWebhooks } = require('./webhooks');

const healthRoutes = require('./routes/health');
const userRoutes = require('./routes/users');
const paymentRoutes = require('./routes/payments');

const app = express();
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// API key middleware — applied to everything EXCEPT /health
function requireApiKey(req, res, next) {
  if (req.path === '/health') return next();
  const key = req.header('X-API-Key');
  if (!key || !config.apiKeys.includes(key)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-API-Key' });
  }
  next();
}
app.use(requireApiKey);

// Routes
app.use(healthRoutes);
app.use(userRoutes);
app.use(paymentRoutes);

// Error fallback
app.use((err, req, res, next) => {
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

async function start() {
  await db.connect();

  app.listen(config.port, () => {
    console.log(`✅ multipay-api listening on http://localhost:${config.port}`);
    console.log(`   → BSC RPC: ${config.bsc.rpcUrl.replace(/\/\/.*@/, '//***@')}`);
    console.log(`   → Tron HTTP: ${config.tron.httpUrl}`);
    console.log(`   → watcher every ${config.watcher.intervalMs}ms`);
  });

  // Stagger so the loops don't fire at the exact same instant
  watcher.start();
  setTimeout(async function webhookLoop() {
    while (true) {
      try {
        await tickWebhooks();
      } catch (err) {
        console.error('webhooks loop error:', err.message);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }, 2500);

  // Resume info on startup
  const { collections } = db;
  const [pending, queued] = await Promise.all([
    collections.payments.countDocuments({ status: 'pending' }),
    collections.payments.countDocuments({
      status: 'terminal',
      webhook_status: { $in: ['not_sent', 'sending'] },
    }),
  ]);
  if (pending || queued) {
    console.log(`♻️  resumed: ${pending} pending payment(s), ${queued} queued webhook(s)`);
  }
}

start().catch((err) => {
  console.error('💀 fatal startup error:', err);
  process.exit(1);
});