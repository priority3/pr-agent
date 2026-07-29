import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// root 显式指向本目录(client/),否则从 repo 根运行时 vite 会去根找 index.html。
// 单入口:pr(H5 对话)。管理界面不再内置(由宿主提供,见 docs/reference.md「设计取舍」),
// 产物落 client/dist(dist/pr/index.html + assets/),由 Hono serveStatic 托管。
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pr: resolve(import.meta.dirname, 'pr/index.html'),
      },
    },
  },
})
