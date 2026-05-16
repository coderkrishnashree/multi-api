const { MongoClient } = require('mongodb');
const config = require('./config');
const logger = require('./logger');

let client;
let db;
const collections = {};

async function connect({ retries = 5, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      client = new MongoClient(config.db.url, {
        serverSelectionTimeoutMS: 5000,
        retryWrites: true,
      });
      await client.connect();
      db = client.db(config.db.name);

      collections.users = db.collection('users');
      collections.payments = db.collection('payments');
      collections.deposits = db.collection('deposits');
      collections.counters = db.collection('counters');

      await ensureIndexes();

      logger.info({ db: config.db.name }, 'mongo connected');
      return db;
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn({ attempt, retries, delay, err: err.message }, 'mongo connect failed, retrying');
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`mongo connect failed after ${retries} attempts: ${lastErr.message}`);
}

async function ensureIndexes() {
  await collections.users.createIndex({ user_id: 1 }, { unique: true });
  await collections.users.createIndex({ tron_address: 1 });
  await collections.users.createIndex({ bsc_address: 1 });
  await collections.users.createIndex({
    pending_payment_count: 1,
    unconfirmed_deposit_count: 1,
  });

  await collections.payments.createIndex({ payment_id: 1 }, { unique: true });
  await collections.payments.createIndex({ user_id: 1, status: 1 });
  await collections.payments.createIndex({ status: 1, expires_at: 1 });
  await collections.payments.createIndex({
    status: 1,
    webhook_status: 1,
    next_webhook_at: 1,
  });

  await collections.deposits.createIndex({ network: 1, tx_hash: 1 }, { unique: true });
  await collections.deposits.createIndex({ user_id: 1, seen_at: -1 });
  await collections.deposits.createIndex({ status: 1, network: 1 });
}

async function nextSequence(name) {
  const result = await collections.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // mongodb driver v6 returns the document directly; older versions returned {value}
  return result.value ? result.value.seq : result.seq;
}

async function ping() {
  if (!db) return false;
  try {
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

async function close() {
  if (client) {
    logger.info('closing mongo connection');
    await client.close();
  }
}

module.exports = { connect, close, collections, nextSequence, ping };