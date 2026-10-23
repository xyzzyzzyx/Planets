import { defineConfig } from 'vitest/config';

// Node-side tests (server, shared orbital maths, scripts). Angular tests run via `ng test`.
export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['server/**/*.test.js', 'shared/**/*.test.js', 'scripts/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'shared/**/*.js', 'scripts/**/*.js'],
      exclude: ['**/*.test.js', '**/__fixtures__/**'],
    },
  },
});
