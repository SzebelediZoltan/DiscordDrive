import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // In dev the SPA is served by Vite on a different port from the API, so the
    // dev proxy reproduces what nginx does in production: one same-origin surface.
    // `changeOrigin` stays off so the API sees `Host: localhost:5173` — its
    // same-origin CSRF check compares that against the browser's `Origin`.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the two biggest vendor groups out of the app bundle so a copy
        // tweak does not invalidate the React and animation payloads.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(react|react-dom|react-router|scheduler)\//.test(id)) return 'react'
          if (/node_modules\/(framer-motion|motion-dom|motion-utils)\//.test(id)) return 'motion'
        },
      },
    },
  },
})
