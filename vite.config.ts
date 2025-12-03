import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  // Worker configuration - ensures workers are bundled inline from same origin
  worker: {
    format: 'es'
  },
  server: {
    proxy: {
      // Proxy WebSocket connections to the signaling server
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  }
})
