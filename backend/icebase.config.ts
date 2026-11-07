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
  hosting: { public: '../web/dist', spa: true },
  firebase: { projectId: deployment.projectId, webConfig: deployment.webConfig },
  emulator: { dataDir: '.icebase', port: 4410 },
  environments: { local: { mode: 'emulator' }, prod: { mode: 'firebase' } },
});
