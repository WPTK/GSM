import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: './',
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
  css: false,
});
