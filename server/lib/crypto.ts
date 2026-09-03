import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// 常量时间比较(会话签名 / token 校验)。
export function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

/**
 * 令牌摘要(sha256 hex)。用于把访问令牌以不可逆形式落库。
 *
 * Reason: 库会被快照复制到对象存储,明文令牌落库等于把访问权一起备份出去。
 * 校验时哈希入参、按摘要精确查行 —— 摘要查找本身不做逐字节短路比较,
 * 所以这条路径不需要再套 safeEqual。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 生成 URL 安全的高熵令牌(32 字节 → 43 字符 base64url)。 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

// ─── 运行时覆盖项的静态加密(aes-256-gcm)────────────────────────────────────
// Reason: AI 网关 key 等运行时覆盖项落在业务库(runtime_settings 表),而业务库会被
// 快照/实时复制到对象存储——密文落库让备份链路永远接触不到明文密钥。
// 密钥派生自 SETTINGS_ENCRYPTION_KEY(sha256 → 32 字节);未配置该 env 时拒绝加解密。

function deriveKey(): Buffer {
  const secret = (process.env.SETTINGS_ENCRYPTION_KEY || '').trim()
  if (!secret) throw new Error('SETTINGS_ENCRYPTION_KEY 未配置,无法加解密运行时设置')
  return createHash('sha256').update(secret).digest()
}

/** 加密为 "iv:tag:cipher"(均 base64)。 */
export function encryptValue(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':')
}

/** 解密 encryptValue 的产物;格式/校验失败抛错,由调用方决定降级。 */
export function decryptValue(payload: string): string {
  const [iv, tag, data] = payload.split(':')
  if (!iv || !tag || !data) throw new Error('密文格式非法')
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}
