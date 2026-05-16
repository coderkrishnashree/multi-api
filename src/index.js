const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const watcher = require('./watcher');
const { tickWebhooks } = require('./webhooks');
const { requireApiKey } = require('./middleware/auth');
const cors = require('./middleware/cors');

const healthRoutes = require('./routes/health');
const userRoutes = require('./routes/users');
const paymentRoutes = require('./routes/payments');

const app = express();

// Required so express-rate-limit sees the real client IP behind Render's proxy.
app.set('trust proxy', config.trustProxyHops);

app.use(helmet({
  // We don't serve HTML, so CSP is overkill; keep the rest.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors);
app.use(express.json({ limit: '64kb' }));

app.use(pinoHttp({
  logger,
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, ip: req.ip }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

app.use(rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(requireApiKey);

app.use(healthRoutes);
app.use(userRoutes);
app.use(paymentRoutes);

// Unknown route
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Final error fallback
app.use((err, req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

let server;
let webhookLoopActive = true;

async function start() {
  await db.connect();

  server = app.listen(config.port, () => {
    logger.info({
      port: config.port,
      bsc_rpc_host: new URL(config.bsc.rpcUrl).host,
      tron_rpc_host: new URL(config.tron.httpUrl).host,
      watcher_interval_ms: config.watcher.intervalMs,
    }, 'multipay-api listening');
  });

  watcher.start().catch((err) => {
    logger.error({ err: err.message }, 'watcher exited unexpectedly');
  });

  setTimeout(async function webhookLoop() {
    while (webhookLoopActive) {
      try {
        await tickWebhooks();
      } catch (err) {
        logger.error({ err: err.message }, 'webhooks loop error');
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    logger.info('webhook loop stopped');
  }, 2500);

  const { collections } = db;
  const [pending, queued] = await Promise.all([
    collections.payments.countDocuments({ status: 'pending' }),
    collections.payments.countDocuments({
      status: 'terminal',
      webhook_status: { $in: ['not_sent', 'sending'] },
    }),
  ]);
  if (pending || queued) {
    logger.info({ pending, queued }, 'resumed from previous run');
  }
}

// ----- Graceful shutdown -----

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');

  // Stop accepting new traffic
  const closeServer = new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });

  // Stop background loops
  watcher.stop();
  webhookLoopActive = false;

  // Hard timeout — Render gives ~30s for shutdown
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('shutdown timeout')), config.gracefulShutdownTimeoutMs)
  );

  try {
    await Promise.race([closeServer, timeout]);
    await db.close();
    logger.info('shutdown clean');
    process.exit(0);
  } catch (err) {
    logger.error({ err: err.message }, 'shutdown forced');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason?.message || reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
  // Exceptions leave Node in undefined state; safest is to exit and let Render restart us.
  shutdown('uncaughtException').catch(() => process.exit(1));
});

start().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'fatal startup error');
  process.exit(1);
});