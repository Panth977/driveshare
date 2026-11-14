import { defineConfig } from '@panth977/icebase/config';
import { schema } from './icebase/schema.ts';
import { api } from './icebase/api.ts';
import { deployment } from './deployment.ts';

export default defineConfig({
  name: 'driveshare',
  schema,
  api,
  rules: { firestore: 'icebase/rules/firestore.rules' },
  functions: { source: 'functions', runtime: 'nodejs22', region: deployment.region },
  hosting: {
    public: '../web/dist',
    spa: true,
    // The app shell is re-checked on every load (a deploy shows up at once, also on a TV);
    // hashed bundles never change, so they are cached for good.
    // Short link for the TV's Downloader app: type driveshare-p977.web.app/apk on the remote.
    redirects: [{ source: '/apk', destination: '/tv/DriveShareTV.apk', type: 302 }],
    headers: [
      { source: '**', headers: { 'Cache-Control': 'no-cache' } },
      { source: '/assets/**', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
      { source: '/tv/*.apk', headers: { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="DriveShareTV.apk"' } },
    ],
  },
  firebase: { projectId: deployment.projectId, webConfig: deployment.webConfig },
  emulator: { dataDir: '.icebase', port: 4410 },
  environments: { local: { mode: 'emulator' }, prod: { mode: 'firebase' } },
});
