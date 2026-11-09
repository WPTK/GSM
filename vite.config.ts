import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // Dev: the browser talks to this origin only; the API server is proxied.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  optimizeDeps: {
    include: ['lucide-react'],
  },
  build: {
    // Warn before the 3,000 KiB hard budget enforced by check:bundle-size.
    chunkSizeWarningLimit: 2900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react-vendor';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'ui-vendor';
          }
        },
      },
    },
  },
});
