import { defineConfig } from 'vite'

export default defineConfig({
  // The driver chain must not be pre-bundled: dev pre-bundling relocates
  // driver-web's worker URL into .vite/deps where the worker file does
  // not exist, and the database open never resolves.
  optimizeDeps: {
    exclude: [
      '@remelondb/driver-web',
      '@remelondb/core',
      '@sqlite.org/sqlite-wasm',
    ],
  },
  server: {
    proxy: { '/sync': { target: 'http://localhost:8787' } },
  },
})
