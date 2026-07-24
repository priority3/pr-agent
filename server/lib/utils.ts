import { clsx, type ClassValue } from 'clsx'
import { customAlphabet } from 'nanoid'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 使用 nanoid 生成 21 字符 ID(供搬迁来的同步 processor/service 用)
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 21)

export function generateId(prefix?: string): string {
  const id = nanoid()
  return prefix ? `${prefix}_${id}` : id
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

/**
 * 计算两个坐标点之间的距离（米），使用 Haversine 公式。
 * 从源仓 sync/parser.ts 搬来,供 processor 生成 split / 轨迹距离用。
 */
export function calculateDistance(
  point1: { lat: number; lon: number },
  point2: { lat: number; lon: number },
): number {
  const R = 6371e3 // 地球半径（米）
  const φ1 = (point1.lat * Math.PI) / 180
  const φ2 = (point2.lat * Math.PI) / 180
  const Δφ = ((point2.lat - point1.lat) * Math.PI) / 180
  const Δλ = ((point2.lon - point1.lon) * Math.PI) / 180

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c // 距离（米）
}
