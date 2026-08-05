import { defineConfig } from 'vite';

/**
 * Builds the determinism harness into a plain Node bundle.
 *
 * Vite is already here and understands the project's module resolution, so
 * this costs zero new dependencies — deliberately, since CLAUDE.md says to
 * ask before adding any. Swap in a real test runner when there's enough of a
 * suite to justify one.
 */
export default defineConfig({
  build: {
    ssr: true,
    target: 'node22',
    outDir: '.harness',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: 'test/determinism.ts',
      output: { entryFileNames: 'determinism.mjs', format: 'esm' },
    },
  },
});
