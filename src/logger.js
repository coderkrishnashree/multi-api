const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: process.env.LOG_LEVEL || (config.nodeEnv === 'production' ? 'info' : 'debug'),
  base: { service: 'multipay-api', env: config.nodeEnv },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.privateKey',
      '*.mnemonic',
      '*.MASTER_MNEMONIC',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;