import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  server: { host: '0.0.0.0', port: 4200, proxy: { '/api': 'http://127.0.0.1:8080' } },
  preview: { host: '0.0.0.0' },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] },
});
