import { timingSafeEqual } from 'node:crypto'

// 抽离版只需常量时间比较(会话签名 / token 校验)。
// 原仓 crypto.ts 的 aes-256-gcm 设置项加解密属 admin app_settings,不随 PR agent 抽离。
export function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}
