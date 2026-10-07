const { randomBytes } = require('node:crypto');
const { readFileSync, appendFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('dotenv');

const path = resolve(__dirname, '../.env');
const contents = readFileSync(path, 'utf8');
const existing = process.env.IRD_CREDENTIAL_ENCRYPTION_KEY || parse(contents).IRD_CREDENTIAL_ENCRYPTION_KEY;
if (existing) {
  if (!/^[a-fA-F0-9]{64}$/.test(existing)) throw new Error('IRD_CREDENTIAL_ENCRYPTION_KEY must contain 64 hexadecimal characters. Existing key was not changed.');
  console.log('IRD encryption key already configured; preserved existing key.');
} else {
  if (/^\s*IRD_CREDENTIAL_ENCRYPTION_KEY\s*=/m.test(contents)) throw new Error('An empty IRD_CREDENTIAL_ENCRYPTION_KEY entry exists. Fill it with a generated 32-byte hexadecimal key.');
  appendFileSync(path, `\nIRD_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`);
  console.log('Generated IRD encryption key in backend .env. Back up this key securely; do not rotate it without re-encrypting stored credentials.');
}
