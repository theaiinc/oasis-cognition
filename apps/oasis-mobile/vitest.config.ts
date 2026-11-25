import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate from vite.config.ts so tests don't run the PWA plugin.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@oasis/ui-kit': path.resolve(__dirname, '../../packages/ui-kit/src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
