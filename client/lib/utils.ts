import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// 前端专用小工具:仅 cn + formatDateTime。刻意不 import server/lib —— 前后端独立构建,
// 避免把服务端依赖(libsql/drizzle 等)拖进浏览器 bundle。
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDateTime(value?: string | number | Date | null) {
  if (!value) return '从未'

  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
