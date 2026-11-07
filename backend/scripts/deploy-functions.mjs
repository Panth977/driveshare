// Bundle the Cloud Functions with esbuild and deploy them with firebase-tools.
// (Same as `icebase deploy --only functions`, with one bundle that holds a single IceBase copy.)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.icebase/functions');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = Object.fromEntries(['firebase', 'firebase-admin', 'firebase-functions'].map((d) => [d, pkg.dependencies[d]]));
const { deployment } = await import(join(root, 'deployment.ts')).catch(async () => {
  // Node < 23 cannot import .ts: read the project id with a regex instead.
  const src = readFileSync(join(root, 'deployment.ts'), 'utf8');
  return { deployment: { projectId: /projectId: '([^']+)'/.exec(src)[1] } };
});

if (!existsSync(join(root, 'functions/.env'))) {
  console.error('backend/functions/.env is missing: copy backend/functions/.env.example and set ADMIN_EMAILS.');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'functions/src/index.ts')],
  outfile: join(out, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(deps).flatMap((d) => [d, `${d}/*`]),
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // '@panth977/icebase' is an npm alias of the JSR package that icebase-server imports as '@jsr/panth977__icebase': one copy.
  alias: { '@panth977/icebase': '@jsr/panth977__icebase' },
  logLevel: 'warning',
});
copyFileSync(join(root, 'functions/.env'), join(out, '.env'));
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'driveshare-functions', private: true, type: 'module', main: 'index.js', engines: { node: '22' }, dependencies: deps }, null, 2) + '\n');
const fb = join(root, '.icebase/firebase.json');
writeFileSync(fb, JSON.stringify({ functions: { source: 'functions', runtime: 'nodejs22' } }, null, 2) + '\n');
console.log('bundled → backend/.icebase/functions/index.js');
if (!process.argv.includes('--build-only')) {
  execFileSync(join(root, '../node_modules/.bin/firebase'), ['deploy', '--only', 'functions', '--project', deployment.projectId, '--config', fb, '--non-interactive', '--force'], { cwd: join(root, '.icebase'), stdio: 'inherit' });
}
