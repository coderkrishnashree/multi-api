// Run ONCE: `npm run generate-mnemonic`
// Copy the output into your .env as MASTER_MNEMONIC.
// Back it up to 1Password / a hardware safe immediately.

const bip39 = require('bip39');

const mnemonic = bip39.generateMnemonic(256); // 24 words, max entropy

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║  MASTER MNEMONIC — store securely, NEVER commit, NEVER lose  ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');
console.log(mnemonic);
console.log('\nAdd to .env as:');
console.log(`MASTER_MNEMONIC="${mnemonic}"`);
console.log('\nALSO save this in 1Password (or equivalent) before continuing.\n');