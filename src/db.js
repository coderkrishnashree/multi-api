const { MongoClient } = require('mongodb');
const config = require('./config');

let client;
let db;

const collections = {};

async function connect() {
  client = new MongoClient(config.db.url);
  await client.connect();
  db = client.db(config.db.name);

  collections.users = db.collection('users');
  collections.payments = db.collection('payments');
  collections.deposits = db.collection('deposits');
  collections.counters = db.collection('counters');

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

  await collections.deposits.createIndex(
    { network: 1, tx_hash: 1 },
    { unique: true }
  );
  await collections.deposits.createIndex({ user_id: 1, seen_at: -1 });
  await collections.deposits.createIndex({ status: 1, network: 1 });

  console.log(`✅ mongo connected (${config.db.name})`);
  return db;
}

// Atomic counter — used for HD derivation indices
async function nextSequence(name) {
  const result = await collections.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return result.value ? result.value.seq : result.seq;
}

async function close() {
  if (client) await client.close();
}

module.exports = { connect, close, collections, nextSequence };