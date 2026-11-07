// One-time setup of a new deployment's secrets (Secret Manager, via firebase-tools):
//   TOKEN_KEY            random 32 bytes: encrypts the Google refresh tokens the functions keep
//   GOOGLE_CLIENT_SECRET your OAuth web client's secret (pasted when asked)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = /projectId: '([^']+)'/.exec(readFileSync(join(root, 'deployment.ts'), 'utf8'))[1];
const firebase = join(root, '../node_modules/.bin/firebase');
const set = (name, value) => execFileSync(firebase, ['functions:secrets:set', name, '--project', projectId, '--data-file', '-', '--force'], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });

if (!process.argv.includes('--keep-token-key')) set('TOKEN_KEY', randomBytes(32).toString('base64'));
const secret = process.env.GOOGLE_CLIENT_SECRET;
if (secret) set('GOOGLE_CLIENT_SECRET', secret);
else console.log('Set the OAuth client secret with:  GOOGLE_CLIENT_SECRET=… npm run setup -- --keep-token-key');
