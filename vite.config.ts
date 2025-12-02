import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import type { ViteDevServer } from 'vite'
import type { Server } from 'http'
import { createSignalingServer } from './server/signaling'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'signaling-server',
      configureServer(server: ViteDevServer) {
        if (server.httpServer) {
          createSignalingServer(server.httpServer as Server)
        }
      }
    }
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
