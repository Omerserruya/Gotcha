import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Path aliases come from tsconfig natively; no plugin needed.
    tsconfigPaths: true,
    alias: {
      /*
       * `server-only` throws by design when loaded outside a Server Component.
       * That guard is exactly what we want in the app and exactly what we do
       * not want in a unit test of a pure function that happens to live in a
       * server module. Stubbing it here keeps the production guard intact.
       */
      'server-only': new URL('./src/test/server-only-stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: true,
  },
});
