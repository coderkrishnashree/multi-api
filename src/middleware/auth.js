const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');

// Pre-compute key buffers once; comparison must be over fixed-length buffers.
const KEY_BUFFERS = config.apiKeys.map(k => Buffer.from(k));

function timingSafeIncludes(presented) {
  const presentedBuf = Buffer.from(presented);
  let match = false;
  for (const k of KEY_BUFFERS) {
    if (k.length !== presentedBuf.length) continue;
    // Even if a length-mismatched key short-circuits above, this loop still
    // runs over all same-length candidates with constant-time compare each.
    if (crypto.timingSafeEqual(k, presentedBuf)) match = true;
  }
  return match;
}

function requireApiKey(req, res, next) {
  if (req.path === '/health' || req.path === '/health/live' || req.path === '/health/ready') {
    return next();
  }
  const key = req.header('X-API-Key');
  if (!key || !timingSafeIncludes(key)) {
    logger.warn({ path: req.path, ip: req.ip }, 'unauthorized request');
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-API-Key' });
  }
  next();
}

module.exports = { requireApiKey };