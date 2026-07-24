import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// root 显式指向本目录(client/),否则从 repo 根运行时 vite 会去根找 index.html。
// 两个入口:pr(H5 对话)+ dashboard(mini-admin),各自 index.html;产物落 client/dist,
// 目录结构保留(dist/pr/index.html、dist/dashboard/index.html + 共享 assets/),由 Hono serveStatic 托管。
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pr: resolve(import.meta.dirname, 'pr/index.html'),
        dashboard: resolve(import.meta.dirname, 'dashboard/index.html'),
      },
    },
  },
})
