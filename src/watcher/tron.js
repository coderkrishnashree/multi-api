const { ethers } = require('ethers');
const TronWeb = require('tronweb');
const config = require('../config');

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// Tron addresses in JSON-RPC are EVM-style (0x... 20 bytes).
// Convert Tron base58 (T...) ↔ EVM hex (0x...) using TronWeb's helpers.
function tronToEvm(tronAddr) {
  // TronWeb returns "41" + 20-byte address; EVM uses just the 20 bytes
  const hex = TronWeb.address.toHex(tronAddr);
  return '0x' + hex.slice(2).toLowerCase();
}

function evmToTron(evmAddr) {
  // Reverse: add "41" prefix, decode to base58
  const tronHex = '41' + evmAddr.replace(/^0x/, '').toLowerCase();
  return TronWeb.address.fromHex(tronHex);
}

// USDT TRC-20 contract in EVM hex form (computed once at module load)
const USDT_EVM = tronToEvm(config.tron.usdtContract);

const provider = new ethers.JsonRpcProvider(config.tron.httpUrl);
const usdt = new ethers.Contract(USDT_EVM, ERC20_ABI, provider);

// Tron's USDT contract uses 6 decimals (vs BSC's 18)
const USDT_DECIMALS = 6;

// Confirmed working: QuickNode Tron plan allows at least 1000 blocks
const MAX_BLOCK_RANGE = 1000;

async function fetchIncomingTransfers(tronAddress, fromBlock) {
  const currentBlock = await provider.getBlockNumber();

  let safeFromBlock;
  if (!fromBlock || fromBlock < currentBlock - MAX_BLOCK_RANGE) {
    safeFromBlock = currentBlock - MAX_BLOCK_RANGE;
  } else {
    safeFromBlock = fromBlock;
  }

  const evmAddress = tronToEvm(tronAddress);
  const filter = usdt.filters.Transfer(null, evmAddress);
  const events = await usdt.queryFilter(filter, safeFromBlock, currentBlock);

  const transfers = events.map((e) => ({
    tx_hash: e.transactionHash,            // 0x-prefixed; strip prefix if displaying on TronScan
    from: evmToTron(e.args.from),          // store as base58 for consistency with sweep code
    to: evmToTron(e.args.to),
    amount: ethers.formatUnits(e.args.value, USDT_DECIMALS),
    block_number: e.blockNumber,
  }));

  return { currentBlock, transfers };
}

async function getCurrentBlock() {
  return provider.getBlockNumber();
}

module.exports = { fetchIncomingTransfers, getCurrentBlock };