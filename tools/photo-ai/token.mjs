#!/usr/bin/env node
// Prints {"value","until"} — the Drive owner's access token, taken from a signed-in DriveShare page
// in a headless Chrome (profile in .photoai/profile). Opening /drive makes the app renew the token
// when it is old (one driveAccess call an hour at most).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILE = process.argv[2] || join(ROOT, '.photoai', 'profile');
const SITE = 'https://driveshare-p977.web.app';
const root = process.env.PWROOT || join(execSync('npm root -g').toString().trim(), '@playwright/cli/node_modules');
const { chromium } = createRequire(root + '/')('playwright-core');
setTimeout(() => { console.error('timeout'); process.exit(2); }, 90000);

const ctx = await chromium.launchPersistentContext(PROFILE, { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await p.goto(`${SITE}/drive?tv=0`).catch(() => {});
  for (let i = 0; i < 60; i++) {
    const t = await p.evaluate(() => JSON.parse(localStorage.getItem('ds.driveToken') ?? 'null')).catch(() => null);
    if (t && t.until > Date.now() + 10 * 60e3) { process.stdout.write(JSON.stringify({ value: t.value, until: t.until })); break; }
    if (t && i === 0) { await p.evaluate(() => localStorage.removeItem('ds.driveToken')); await p.reload().catch(() => {}); }
    await p.waitForTimeout(1000);
  }
} finally { await ctx.close(); }
process.exit(0);
