require('dotenv').config();
const { MongoClient } = require('mongodb');
const { ethers } = require('ethers');
const TronWeb = require('tronweb');
const config = require('./src/config');
const { deriveBsc, deriveTron } = require('./src/wallet');

const DRY_RUN = process.argv.includes('--dry-run');

const BSC_MAIN_WALLET = process.env.BSC_MAIN_WALLET;
const TRON_MAIN_WALLET = process.env.TRON_MAIN_WALLET;
const BSC_GAS_WALLET_PK = process.env.BSC_GAS_WALLET_PK;
const TRON_GAS_WALLET_PK = process.env.TRON_GAS_WALLET_PK;

const MIN_SWEEP_USDT = parseFloat(process.env.MIN_SWEEP_USDT || '2');
const BNB_GAS_TOPUP = process.env.BNB_GAS_TOPUP || '0.0008';
const TRX_GAS_TOPUP = parseFloat(process.env.TRX_GAS_TOPUP || '15');

function requireEnv(name, value) {
  if (!value) { console.error(`❌ missing env: ${name}`); process.exit(1); }
}
requireEnv('BSC_MAIN_WALLET', BSC_MAIN_WALLET);
requireEnv('TRON_MAIN_WALLET', TRON_MAIN_WALLET);
requireEnv('BSC_GAS_WALLET_PK', BSC_GAS_WALLET_PK);
requireEnv('TRON_GAS_WALLET_PK', TRON_GAS_WALLET_PK);

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
];

const bscProvider = new ethers.JsonRpcProvider(config.bsc.rpcUrl);
const bscGasSigner = new ethers.Wallet(BSC_GAS_WALLET_PK, bscProvider);
const bscUsdt = new ethers.Contract(config.bsc.usdtContract, ERC20_ABI, bscProvider);

const tronWeb = new TronWeb({
  fullHost: config.tron.httpUrl,
  privateKey: TRON_GAS_WALLET_PK,
  ...(config.tron.apiKey && { headers: { 'TRON-PRO-API-KEY': config.tron.apiKey } }),
});

async function sweepBscUser(user, swepts) {
  const log = (...a) => console.log(`[BSC ${user.user_id}]`, ...a);
  try {
    const balanceRaw = await bscUsdt.balanceOf(user.bsc_address);
    const balance = parseFloat(ethers.formatUnits(balanceRaw, 18));
    if (balance < MIN_SWEEP_USDT) {
      return log(`skip — balance ${balance} < ${MIN_SWEEP_USDT}`);
    }
    log(`💰 ${balance} USDT to sweep`);

    const derived = deriveBsc(user.derivation_index);
    if (derived.address.toLowerCase() !== user.bsc_address.toLowerCase()) {
      return log(`⚠️  derived mismatch! expected ${user.bsc_address}, got ${derived.address}. Skipping.`);
    }

    const bnb = await bscProvider.getBalance(user.bsc_address);
    const minGas = ethers.parseEther('0.0003');
    if (bnb < minGas) {
      log(`⛽ gas top-up ${BNB_GAS_TOPUP} BNB`);
      if (!DRY_RUN) {
        const gasTx = await bscGasSigner.sendTransaction({
          to: user.bsc_address,
          value: ethers.parseEther(BNB_GAS_TOPUP),
        });
        await gasTx.wait();
      }
    }

    if (DRY_RUN) return log(`[dry-run] would sweep ${balance} → ${BSC_MAIN_WALLET}`);

    const depositSigner = new ethers.Wallet(derived.privateKey, bscProvider);
    const usdtAsDeposit = bscUsdt.connect(depositSigner);
    const tx = await usdtAsDeposit.transfer(BSC_MAIN_WALLET, balanceRaw);
    log(`📤 tx ${tx.hash}`);
    const receipt = await tx.wait();
    log(`✅ swept ${balance} USDT in block ${receipt.blockNumber}`);

    await swepts.insertOne({
      user_id: user.user_id,
      network: 'bsc',
      address: user.bsc_address,
      amount: balance.toString(),
      tx_hash: tx.hash,
      block: receipt.blockNumber,
      destination: BSC_MAIN_WALLET,
      swept_at: new Date(),
    });
  } catch (err) {
    log(`error: ${err.message}`);
  }
}

async function sweepTronUser(user, swepts) {
  const log = (...a) => console.log(`[TRX ${user.user_id}]`, ...a);
  try {
    const contract = await tronWeb.contract().at(config.tron.usdtContract);
    const balanceRaw = await contract.balanceOf(user.tron_address).call();
    const balance = Number(balanceRaw.toString()) / 1e6;
    if (balance < MIN_SWEEP_USDT) {
      return log(`skip — balance ${balance} < ${MIN_SWEEP_USDT}`);
    }
    log(`💰 ${balance} USDT to sweep`);

    const derived = deriveTron(user.derivation_index);
    if (derived.address !== user.tron_address) {
      return log(`⚠️  derived mismatch! expected ${user.tron_address}, got ${derived.address}. Skipping.`);
    }

    const trx = await tronWeb.trx.getBalance(user.tron_address);
    const trxFmt = trx / 1e6;
    if (trxFmt < TRX_GAS_TOPUP) {
      log(`⛽ TRX top-up ${TRX_GAS_TOPUP}`);
      if (!DRY_RUN) {
        await tronWeb.trx.sendTransaction(user.tron_address, TRX_GAS_TOPUP * 1e6);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (DRY_RUN) return log(`[dry-run] would sweep ${balance} → ${TRON_MAIN_WALLET}`);

    const depositTron = new TronWeb({
      fullHost: config.tron.httpUrl,
      privateKey: derived.privateKey,
      ...(config.tron.apiKey && { headers: { 'TRON-PRO-API-KEY': config.tron.apiKey } }),
    });
    const depositContract = await depositTron.contract().at(config.tron.usdtContract);
    const tx = await depositContract.transfer(TRON_MAIN_WALLET, balanceRaw.toString()).send();
    log(`📤 tx ${tx}`);
    log(`✅ swept ${balance} USDT`);

    await swepts.insertOne({
      user_id: user.user_id,
      network: 'tron',
      address: user.tron_address,
      amount: balance.toString(),
      tx_hash: tx,
      destination: TRON_MAIN_WALLET,
      swept_at: new Date(),
    });
  } catch (err) {
    log(`error: ${err.message}`);
  }
}

async function main() {
  console.log(`\n🧹 sweep starting at ${new Date().toISOString()}`);
  console.log(`   mode: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}`);
  console.log(`   threshold: ${MIN_SWEEP_USDT} USDT`);
  console.log(`   destinations: BSC=${BSC_MAIN_WALLET}, TRX=${TRON_MAIN_WALLET}\n`);

  const client = new MongoClient(config.db.url);
  await client.connect();
  const db = client.db(config.db.name);
  const users = db.collection('users');
  const swepts = db.collection('sweep_history');
  await swepts.createIndex({ tx_hash: 1 }, { unique: true });

  const allUsers = await users.find({}).toArray();
  console.log(`📊 ${allUsers.length} user(s) to check\n`);

  console.log('━━━ BSC / BEP-20 ━━━');
  for (const u of allUsers) {
    await sweepBscUser(u, swepts);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n━━━ Tron / TRC-20 ━━━');
  for (const u of allUsers) {
    await sweepTronUser(u, swepts);
    await new Promise(r => setTimeout(r, 1000));
  }

  await client.close();
  console.log(`\n✅ sweep finished at ${new Date().toISOString()}\n`);
}

main().catch(err => {
  console.error('💀 fatal sweep error:', err);
  process.exit(1);
});