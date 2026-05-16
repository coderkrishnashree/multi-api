require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Render sits behind one proxy hop. Set 2 if you add Cloudflare in front.
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '1', 10),

  // Comma-separated list of allowed CORS origins. Empty = no CORS headers.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  gracefulShutdownTimeoutMs: parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || '15000', 10),

  db: {
    url: required('DB_URL'),
    name: process.env.DB_NAME || 'multipay_wrapper',
  },

  apiKeys: (process.env.API_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  webhookSecret: process.env.WEBHOOK_SECRET || '',

  masterMnemonic: required('MASTER_MNEMONIC'),

  bsc: {
    rpcUrl: required('BSC_RPC_URL'),
    usdtContract: process.env.BSC_USDT_CONTRACT || '0x55d398326f99059fF775485246999027B3197955',
    confirmations: parseInt(process.env.BSC_CONFIRMATIONS || '15', 10),
  },

  tron: {
    httpUrl: process.env.TRON_HTTP_URL || 'https://api.trongrid.io',
    usdtContract: process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    confirmations: parseInt(process.env.TRON_CONFIRMATIONS || '19', 10),
    apiKey: process.env.TRON_API_KEY || '',
  },

  watcher: {
    intervalMs: parseInt(process.env.WATCHER_INTERVAL_MS || '5000', 10),
    maxBackoffMs: parseInt(process.env.WATCHER_MAX_BACKOFF_MS || '60000', 10),
  },

  payments: {
    defaultExpirationMin: parseInt(process.env.DEFAULT_PAYMENT_EXPIRATION_MIN || '30', 10),
  },

  webhooks: {
    maxAttempts: 6,
    timeoutMs: 10000,
  },
};

if (config.apiKeys.length === 0) {
  console.warn('⚠️  No API_KEYS configured. Set at least one before deploying.');
}

if (!config.webhookSecret && config.nodeEnv === 'production') {
  console.error('❌ WEBHOOK_SECRET required in production');
  process.exit(1);
}

module.exports = config;