const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('.env already exists; left unchanged.');
} else {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const content = template
    .replace(
      'replace-with-a-random-secret-at-least-32-characters',
      crypto.randomBytes(48).toString('hex'),
    )
    .replace(
      'SEED_PASSWORD=',
      `SEED_PASSWORD=${crypto.randomBytes(18).toString('base64url')}`,
    );
  fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  console.log(
    'Created .env with random development secrets. Review DATABASE_URL before running migrations.',
  );
}
