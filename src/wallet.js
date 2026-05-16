const bip39 = require('bip39');
const { ethers } = require('ethers');
const TronWeb = require('tronweb');
const config = require('./config');

// Validate the master mnemonic ONCE at startup
if (!bip39.validateMnemonic(config.masterMnemonic)) {
  console.error('❌ MASTER_MNEMONIC is not a valid BIP39 phrase.');
  console.error('   Generate one with: npm run generate-mnemonic');
  process.exit(1);
}

const TRON_PATH = (index) => `m/44'/195'/${index}'/0/0`;
const BSC_PATH = (index) => `m/44'/60'/0'/0/${index}`;

/**
 * Derive a BSC (EVM) wallet at the given HD index.
 * Returns { address, privateKey }.
 */
function deriveBsc(index) {
  const wallet = ethers.HDNodeWallet.fromPhrase(
    config.masterMnemonic,
    undefined,
    BSC_PATH(index)
  );
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

/**
 * Derive a Tron wallet at the given HD index.
 * Returns { address, privateKey } (address in base58, starts with T).
 *
 * Handles both TronWeb v4 (address = { base58, hex }) and v5+ (address = string).
 */
function deriveTron(index) {
  const account = TronWeb.utils.accounts.generateAccountWithMnemonic(
    config.masterMnemonic,
    TRON_PATH(index)
  );
  const address = typeof account.address === 'string'
    ? account.address
    : account.address.base58;

  if (!address || !address.startsWith('T')) {
    throw new Error(
      `deriveTron(${index}) returned invalid address: ${JSON.stringify(account.address)}`
    );
  }

  return {
    address,
    privateKey: account.privateKey,
  };
}

/**
 * Derive both addresses (public only) for a user index.
 * Used when creating a user — we cache the addresses in Mongo.
 */
function deriveAddresses(index) {
  return {
    bsc_address: deriveBsc(index).address,
    tron_address: deriveTron(index).address,
  };
}

module.exports = {
  deriveBsc,
  deriveTron,
  deriveAddresses,
  TRON_PATH,
  BSC_PATH,
};