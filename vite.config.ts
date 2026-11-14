import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
    assetsInlineLimit: 0, // CSP: font-src/img-src 'self', no data: URIs
    rollupOptions: { input: { index: 'ui/index.html', legacy: 'ui/legacy.html' } },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
