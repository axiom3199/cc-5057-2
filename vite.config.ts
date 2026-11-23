import { defineConfig } from 'vitest/config';
export default defineConfig({
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true },
  test: {
    // The acceptance suite generates full-resolution terrain several times per case; the default 5s
    // is far below what a legitimate run needs.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
