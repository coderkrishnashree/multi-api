// scripts/dedupe-deposits.js
//
// One-shot migration: removes duplicate documents in the `deposits` collection
// caused by the missing unique index on (network, tx_hash). For each duplicate
// group, the earliest-inserted document (lowest _id) is kept; the rest are
// deleted.
//
// Run BEFORE restarting the server, because ensureIndexes() in src/db.js now
// creates a unique index on { network: 1, tx_hash: 1 } and that build fails
// while duplicates still exist.
//
// Usage:
//   node scripts/dedupe-deposits.js --dry-run   # report only
//   node scripts/dedupe-deposits.js             # actually delete

require('dotenv').config();
const { MongoClient } = require('mongodb');

const DRY_RUN = process.argv.includes('--dry-run');
const DB_URL = process.env.DB_URL;
const DB_NAME = process.env.DB_NAME || 'multipay_wrapper';

if (!DB_URL) {
  console.error('DB_URL not set in .env');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(DB_URL, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  console.log(`✓ connected to "${DB_NAME}"`);
  console.log(DRY_RUN
    ? '🔍 DRY RUN — no documents will be deleted\n'
    : '⚠️  LIVE — duplicates will be deleted\n');

  const deposits = client.db(DB_NAME).collection('deposits');

  // Sort by _id ascending so $push accumulates earliest-first.
  // ObjectIds embed a timestamp, so ids[0] is the earliest-inserted doc.
  const dupGroups = await deposits.aggregate([
    { $sort: { _id: 1 } },
    {
      $group: {
        _id: { network: '$network', tx_hash: '$tx_hash' },
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (dupGroups.length === 0) {
    console.log('✓ no duplicates found — safe to start the server');
    await client.close();
    return;
  }

  console.log(`found ${dupGroups.length} duplicate group(s):\n`);
  let totalToDelete = 0;
  for (const g of dupGroups) {
    const keepId = g.ids[0];
    const removeIds = g.ids.slice(1);
    totalToDelete += removeIds.length;
    console.log(`  ${g._id.network}  ${g._id.tx_hash}`);
    console.log(`    keep    : ${keepId}`);
    console.log(`    remove  : ${removeIds.length} doc(s)`);
  }
  console.log(`\ntotal docs to delete: ${totalToDelete}`);

  if (DRY_RUN) {
    console.log('\n(dry run — no changes made. re-run without --dry-run to apply.)');
    await client.close();
    return;
  }

  let deleted = 0;
  for (const g of dupGroups) {
    const removeIds = g.ids.slice(1);
    const result = await deposits.deleteMany({ _id: { $in: removeIds } });
    deleted += result.deletedCount;
  }
  console.log(`\n✓ deleted ${deleted} duplicate document(s)`);

  // Verify nothing slipped through (e.g. a concurrent insert during the run)
  const stillDup = await deposits.aggregate([
    { $group: { _id: { network: '$network', tx_hash: '$tx_hash' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (stillDup.length === 0) {
    console.log('✓ verified — no duplicates remain. you can now `npm run dev`.');
  } else {
    console.log(`⚠️  ${stillDup.length} duplicate group(s) still exist — re-run the script`);
  }

  await client.close();
}

main().catch(err => {
  console.error('error:', err);
  process.exit(1);
});