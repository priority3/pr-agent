import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// root 显式指向本目录(client/),否则从 repo 根运行时 vite 会去根找 index.html。
// 构建产物落 client/dist(相对 root),由 Hono serveStatic 托管。
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
