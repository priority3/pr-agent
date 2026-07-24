/**
 * PR 对话图片上传的存取(存到 admin 配置卷,重建/重启后仍在)。
 * 仅支持 Claude 视觉可用的类型(jpeg/png/gif/webp)。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { generateId } from '@/lib/utils'

const UPLOAD_DIR = process.env.PR_UPLOAD_DIR || '/app/data/uploads'

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

export const SUPPORTED_IMAGE_TYPES = Object.keys(EXT_BY_TYPE)

export async function saveImageUpload(bytes: Buffer, mediaType: string): Promise<{ name: string; url: string }> {
  const ext = EXT_BY_TYPE[mediaType]
  if (!ext) throw new Error(`unsupported image type: ${mediaType}`)
  await mkdir(UPLOAD_DIR, { recursive: true })
  const name = `${generateId('img')}.${ext}`
  await writeFile(path.join(UPLOAD_DIR, name), bytes)
  return { name, url: `/api/pr/image/${name}` }
}

export async function readImageUpload(name: string): Promise<{ bytes: Buffer; mediaType: string } | null> {
  // 防目录穿越:文件名只允许安全字符。
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) return null
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const mediaType = TYPE_BY_EXT[ext]
  if (!mediaType) return null
  const fp = path.join(UPLOAD_DIR, name)
  if (!existsSync(fp)) return null
  return { bytes: await readFile(fp), mediaType }
}

/** 从 `/api/pr/image/<name>` 反解出文件名。 */
export function uploadNameFromUrl(url: string): string | null {
  const m = url.match(/\/api\/pr\/image\/([A-Za-z0-9_.-]+)(?:\?|$)/)
  return m ? m[1] : null
}
