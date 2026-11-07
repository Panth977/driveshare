import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { deployment } from '../backend/deployment.ts';

export default defineConfig({
  plugins: [svelte()],
  server: { port: deployment.devPort, strictPort: true },
  preview: { port: deployment.devPort, strictPort: true },
  build: { target: 'es2022' },
});
