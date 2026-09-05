import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'src/client',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: true,
    port: 5173,
    // src/shared лежит выше корня vite — без этого dev-сервер откажется его отдавать.
    fs: { allow: [root] },
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
