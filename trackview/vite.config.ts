import { defineConfig } from 'vitest/config';

// Tauri expects a fixed dev port and serves the built files from dist/.
export default defineConfig({
  clearScreen: false,
  // The dev server may also read the sample files (used for manual testing).
  server: { port: 5173, strictPort: true, fs: { allow: ['.', '../example_GPSfiles'] } },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 1500 },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
