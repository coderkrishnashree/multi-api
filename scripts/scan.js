// scripts/scan.js
// Derive child addresses from MASTER_MNEMONIC and report USDT + native gas balances.
//
// Usage:
//   node scripts/scan.js                       # scan all known indices from Mongo
//   node scripts/scan.js --from 0 --to 50      # scan a range (no Mongo needed)
//   node scripts/scan.js --user customer_42    # scan one specific user
//   node scripts/scan.js --network bsc         # only BSC
//   node scripts/scan.js --network tron        # only Tron
//   node scripts/scan.js --nonzero             # only print rows with any balance
//   node scripts/scan.js --json                # machine-readable output (for piping)
//
// Examples:
//   node scripts/scan.js --from 0 --to 100 --nonzero
//   node scripts/scan.js --user customer_42 --json | jq

require('dotenv').config();
const { ethers } = require('ethers');
const TronWeb = require('tronweb');
const { MongoClient } = require('mongodb');
const config = require('../src/config');
const { deriveBsc, deriveTron } = require('../src/wallet');

// ──────────────── args ────────────────
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
function flag(name) { return args.includes(`--${name}`); }

const fromArg = arg('from');
const toArg = arg('to');
const userArg = arg('user');
const networkArg = arg('network'); // 'bsc' | 'tron' | null
const nonzeroOnly = flag('nonzero');
const jsonOut = flag('json');

const log = jsonOut ? () => {} : console.log;

// ──────────────── RPC setup ────────────────
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const bscProvider = new ethers.JsonRpcProvider(config.bsc.rpcUrl);
const bscUsdt = new ethers.Contract(config.bsc.usdtContract, ERC20_ABI, bscProvider);

const tronProvider = new ethers.JsonRpcProvider(config.tron.httpUrl);

// USDT TRC-20 contract address as EVM hex (for JSON-RPC calls)
function tronToEvm(base58) {
  const hex = TronWeb.address.toHex(base58);
  return '0x' + hex.slice(2).toLowerCase();
}
const tronUsdtEvm = tronToEvm(config.tron.usdtContract);
const tronUsdt = new ethers.Contract(tronUsdtEvm, ERC20_ABI, tronProvider);

const BSC_USDT_DECIMALS = 18;
const TRON_USDT_DECIMALS = 6;

// ──────────────── balance fetchers ────────────────
async function bscBalances(bscAddress) {
  const [usdtRaw, bnbRaw] = await Promise.all([
    bscUsdt.balanceOf(bscAddress).catch((e) => { throw new Error(`bsc usdt: ${e.message}`); }),
    bscProvider.getBalance(bscAddress).catch((e) => { throw new Error(`bsc bnb: ${e.message}`); }),
  ]);
  return {
    usdt: parseFloat(ethers.formatUnits(usdtRaw, BSC_USDT_DECIMALS)),
    native: parseFloat(ethers.formatEther(bnbRaw)),
  };
}

async function tronBalances(tronBase58) {
  const evm = tronToEvm(tronBase58);
  const [usdtRaw, trxRaw] = await Promise.all([
    tronUsdt.balanceOf(evm).catch((e) => { throw new Error(`tron usdt: ${e.message}`); }),
    tronProvider.getBalance(evm).catch((e) => { throw new Error(`tron trx: ${e.message}`); }),
  ]);
  return {
    usdt: parseFloat(ethers.formatUnits(usdtRaw, TRON_USDT_DECIMALS)),
    // Tron native balance via JSON-RPC comes back in SUN (1 TRX = 1e6 SUN), but
    // ethers' getBalance assumes 18 decimals (wei). QuickNode's Tron RPC layer
    // normalizes to 18 decimals to match Ethereum tooling. Verify your endpoint:
    // if balances look 12 orders of magnitude off, switch to formatUnits(..., 6).
    native: parseFloat(ethers.formatEther(trxRaw)),
  };
}

// ──────────────── range resolution ────────────────
async function resolveIndices() {
  // Explicit --from / --to → use that range, no Mongo
  if (fromArg !== null && toArg !== null) {
    const from = parseInt(fromArg, 10);
    const to = parseInt(toArg, 10);
    if (isNaN(from) || isNaN(to) || from < 0 || to < from) {
      throw new Error('--from and --to must be non-negative integers with to >= from');
    }
    const indices = [];
    for (let i = from; i <= to; i++) indices.push({ index: i, user_id: null });
    return { indices, source: 'range' };
  }

  // Otherwise query Mongo for known users
  const client = new MongoClient(config.db.url);
  await client.connect();
  const db = client.db(config.db.name);
  const users = db.collection('users');

  const query = userArg ? { user_id: userArg } : {};
  const rows = await users
    .find(query, { projection: { user_id: 1, derivation_index: 1 } })
    .sort({ derivation_index: 1 })
    .toArray();

  await client.close();

  if (userArg && rows.length === 0) {
    throw new Error(`user "${userArg}" not found in Mongo`);
  }

  return {
    indices: rows.map(r => ({ index: r.derivation_index, user_id: r.user_id })),
    source: 'mongo',
  };
}

// ──────────────── main ────────────────
async function main() {
  log(`🔍 scanning addresses (network: ${networkArg || 'both'})`);

  const { indices, source } = await resolveIndices();
  log(`   ${indices.length} indices (source: ${source})`);
  log('');

  // Header
  if (!jsonOut) {
    const headers = ['idx', 'user_id'];
    if (!networkArg || networkArg === 'bsc') headers.push('bsc_address', 'USDT', 'BNB');
    if (!networkArg || networkArg === 'tron') headers.push('tron_address', 'USDT', 'TRX');
    console.log(headers.join(' | '));
    console.log('-'.repeat(120));
  }

  let totals = { bscUsdt: 0, bnb: 0, tronUsdt: 0, trx: 0 };
  const results = [];

  for (const { index, user_id } of indices) {
    const row = { index, user_id };

    try {
      if (!networkArg || networkArg === 'bsc') {
        const bsc = deriveBsc(index);
        const bal = await bscBalances(bsc.address);
        row.bsc_address = bsc.address;
        row.bsc_usdt = bal.usdt;
        row.bnb = bal.native;
        totals.bscUsdt += bal.usdt;
        totals.bnb += bal.native;
      }

      if (!networkArg || networkArg === 'tron') {
        const tron = deriveTron(index);
        const bal = await tronBalances(tron.address);
        row.tron_address = tron.address;
        row.tron_usdt = bal.usdt;
        row.trx = bal.native;
        totals.tronUsdt += bal.usdt;
        totals.trx += bal.native;
      }
    } catch (err) {
      row.error = err.message;
    }

    results.push(row);

    if (jsonOut) {
      // streamed JSONL — easier to pipe through jq
      console.log(JSON.stringify(row));
    } else {
      const hasAny = (row.bsc_usdt || 0) + (row.bnb || 0) +
                     (row.tron_usdt || 0) + (row.trx || 0) > 0;
      if (nonzeroOnly && !hasAny && !row.error) continue;

      const parts = [
        String(index).padStart(4),
        (user_id || '—').padEnd(20).slice(0, 20),
      ];
      if (!networkArg || networkArg === 'bsc') {
        parts.push(
          row.bsc_address || '',
          (row.bsc_usdt ?? 0).toFixed(4).padStart(10),
          (row.bnb ?? 0).toFixed(6).padStart(10)
        );
      }
      if (!networkArg || networkArg === 'tron') {
        parts.push(
          row.tron_address || '',
          (row.tron_usdt ?? 0).toFixed(4).padStart(10),
          (row.trx ?? 0).toFixed(4).padStart(10)
        );
      }
      console.log(parts.join(' | ') + (row.error ? `  ⚠️ ${row.error}` : ''));
    }

    // Polite delay so we don't blow through RPC limits
    await new Promise(r => setTimeout(r, 100));
  }

  if (!jsonOut) {
    console.log('-'.repeat(120));
    if (!networkArg || networkArg === 'bsc') {
      console.log(`Total BSC : ${totals.bscUsdt.toFixed(4)} USDT  |  ${totals.bnb.toFixed(6)} BNB`);
    }
    if (!networkArg || networkArg === 'tron') {
      console.log(`Total TRON: ${totals.tronUsdt.toFixed(4)} USDT  |  ${totals.trx.toFixed(4)} TRX`);
    }
    if (!networkArg) {
      console.log(`Grand total USDT (both networks): ${(totals.bscUsdt + totals.tronUsdt).toFixed(4)}`);
    }
  } else {
    console.log(JSON.stringify({ totals }));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('💀 scan failed:', err.message);
    process.exit(1);
  });