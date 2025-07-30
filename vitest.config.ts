import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '.nx/',
        'tmp/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        '**/test/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@evaluatorq': resolve(__dirname, './packages'),
    },
  },
});
