require('dotenv').config();
const TronWeb = require('tronweb');

const pk = (process.env.TRON_GAS_WALLET_PK || '').trim().replace(/^0x/, '');
const url = (process.env.TRON_HTTP_URL || '').replace(/\/jsonrpc\/?$/, '');

console.log('1. pk length:', pk.length, '(want 64)');
console.log('2. pk all hex?:', /^[0-9a-fA-F]{64}$/.test(pk));

try {
  console.log('3. address from pk:', TronWeb.address.fromPrivateKey(pk));
} catch (e) {
  console.log('3. fromPrivateKey threw:', e.message);
}

console.log('4. http api url:', url);

const tw = new TronWeb({ fullHost: url, privateKey: pk });
console.log('5. defaultPrivateKey set?:', !!tw.defaultPrivateKey, 'len:', tw.defaultPrivateKey && tw.defaultPrivateKey.length);
console.log('6. defaultAddress:', tw.defaultAddress);

(async () => {
  try {
    const block = await tw.trx.getCurrentBlock();
    console.log('7. getCurrentBlock OK, block:', block.block_header.raw_data.number);
  } catch (e) {
    console.log('7. getCurrentBlock threw:', e.message || e);
  }
})();
