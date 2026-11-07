// Firebase Hosting: web/dist (run `npm run build` first; `npm run deploy:web` does both).
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(root, '../node_modules/@panth977/icebase-cli/src/cli/index.js'), 'deploy', '--env', 'prod', '--only', 'hosting'], { cwd: root, stdio: 'inherit' });
