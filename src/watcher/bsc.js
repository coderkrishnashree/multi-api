const { ethers } = require('ethers');
const config = require('../config');

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(config.bsc.rpcUrl);
const usdt = new ethers.Contract(config.bsc.usdtContract, ERC20_ABI, provider);

/**
 * Fetch incoming USDT transfers to `address` since `fromBlock`.
 * Returns: [{ tx_hash, from, to, amount, block_number }, ...]
 */
async function fetchIncomingTransfers(address, fromBlock) {
  const filter = usdt.filters.Transfer(null, address);
  const currentBlock = await provider.getBlockNumber();
  // Cap range to avoid huge queries; BSC public nodes typically allow ~5000 blocks
  const safeFromBlock = Math.max(fromBlock || currentBlock - 100, currentBlock - 5000);

  const events = await usdt.queryFilter(filter, safeFromBlock, currentBlock);

  return {
    currentBlock,
    transfers: events.map((e) => ({
      tx_hash: e.transactionHash,
      from: e.args.from,
      to: e.args.to,
      amount: ethers.formatUnits(e.args.value, 18), // BEP-20 USDT = 18 decimals
      block_number: e.blockNumber,
    })),
  };
}

async function getCurrentBlock() {
  return provider.getBlockNumber();
}

module.exports = { fetchIncomingTransfers, getCurrentBlock };