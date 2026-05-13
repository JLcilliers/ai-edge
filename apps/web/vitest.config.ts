import { defineConfig } from 'vitest/config';

/**
 * Vitest config — kept minimal. Tests live next to the code they
 * exercise (e.g. `app/lib/suppression/backlinks.test.ts`). No JSX/dom
 * tests yet, so the default node environment is fine.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts'],
  },
});
