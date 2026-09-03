/**
 * H5 对话的访问令牌:一次性入口链接 → 设备令牌。
 *
 * 取代原先的单枚长期共享 token(PR_CHAT_TOKEN)。那枚 token 永不过期、无法吊销,
 * 却必然出现在推送服务端的消息体、浏览器历史与图片请求日志里 —— 任一处泄露
 * 就是永久读写全部对话与健康数据。
 *
 * 现在的两段式:
 * 1. 管理接口签发一次性链接(`/pr?t=<invite>`),7 天不用自动过期;
 * 2. H5 页面拿 invite 换一枚**设备专属**令牌(90 天滑动过期、可单独吊销),
 *    invite 随即作废。
 *
 * 两张表都只存 sha256(token)(见 db/schema.ts 的注释)。
 */
import { desc, eq } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { prChatDevices, prChatInvites } from '@/lib/db/schema'
import { decryptValue, encryptValue, generateToken, hashToken } from '@/lib/crypto'
import { generateId } from '@/lib/utils'

/** 一次性链接的有效期(未兑换)。 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 设备令牌的有效期(每次使用滑动续期)。 */
const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * 兑换幂等窗口:首次兑换后这段时间内,同一 invite 再兑换返回**同一枚**设备令牌。
 *
 * Reason: 严格「一次性」会被三件小事直接锁死 —— React StrictMode 的双跑 effect、
 * 用户在兑换页手滑刷新、弱网下响应丢包。而链接是管理接口手动签发的,重签得先
 * admin 登录一轮,代价远高于这个窗口带来的风险(窗口内仍要求持有原 invite 明文)。
 */
const REDEEM_GRACE_MS = 10 * 60 * 1000

/** 设备令牌校验结果的内存缓存时长。auth 中间件每请求都要校验,不能每次打库。 */
const VERIFY_CACHE_TTL_MS = 60_000

/** 滑动续期的写库节流:距上次记账不足这个间隔就不写。 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

export interface ChatInviteIssued {
  token: string
  url: string
  expiresAt: Date
}

export interface ChatDeviceGranted {
  token: string
  expiresAt: Date
}

export type RedeemFailure = 'invalid' | 'expired' | 'used'

export type RedeemResult = { ok: true; grant: ChatDeviceGranted } | { ok: false; reason: RedeemFailure }

// hash → { deviceId, cachedUntil }。只缓存校验通过的结果;失败走原路打库(失败频率低)。
const verifyCache = new Map<string, { deviceId: string; cachedUntil: number }>()
// deviceId → 上次滑动续期的时刻,配合 TOUCH_INTERVAL_MS 节流。
const lastTouchAt = new Map<string, number>()

/** 一次性链接的完整地址。PUBLIC_BASE_URL 留空则给相对路径(自部署单机直连时够用)。 */
function buildInviteUrl(token: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  return `${base}/pr?t=${encodeURIComponent(token)}`
}

/** 签发一次性入口链接。明文 token 只在这一次返回,库里只留摘要。 */
export async function createChatInvite(note?: string | null): Promise<ChatInviteIssued> {
  const db = await getActivitiesDb()
  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)

  await db.insert(prChatInvites).values({
    id: generateId('invite'),
    tokenHash: hashToken(token),
    expiresAt,
    note: note?.trim() || null,
  })

  return { token, url: buildInviteUrl(token), expiresAt }
}

/** 建一枚设备令牌,返回明文与到期时间。 */
async function grantDevice(label: string | null, inviteId: string | null): Promise<{ id: string; grant: ChatDeviceGranted }> {
  const db = await getActivitiesDb()
  const token = generateToken()
  const expiresAt = new Date(Date.now() + DEVICE_TTL_MS)
  const id = generateId('device')

  await db.insert(prChatDevices).values({
    id,
    tokenHash: hashToken(token),
    label,
    inviteId,
    expiresAt,
  })

  return { id, grant: { token, expiresAt } }
}

/**
 * 用一次性 token 换设备令牌。成功后 invite 立即作废(仅幂等窗口内可重复兑换)。
 *
 * label 用于在设备列表里认出是哪台机器(取 User-Agent 摘要),不参与鉴权。
 */
export async function redeemChatInvite(token: string, label?: string | null): Promise<RedeemResult> {
  if (!token) return { ok: false, reason: 'invalid' }

  const db = await getActivitiesDb()
  const [invite] = await db.select().from(prChatInvites).where(eq(prChatInvites.tokenHash, hashToken(token))).limit(1)
  if (!invite) return { ok: false, reason: 'invalid' }

  const now = Date.now()

  // 已兑换过:先看幂等窗口,再判过期 —— 在有效期内兑换过的 invite,即便链接本身
  // 此刻已过 7 天,窗口内的重试也该拿到同一枚令牌。
  if (invite.usedAt) {
    const withinGrace = now - invite.usedAt.getTime() <= REDEEM_GRACE_MS
    if (withinGrace && invite.deviceTokenEnc && invite.deviceId) {
      const [device] = await db.select().from(prChatDevices).where(eq(prChatDevices.id, invite.deviceId)).limit(1)
      if (device && !device.revokedAt) {
        try {
          return { ok: true, grant: { token: decryptValue(invite.deviceTokenEnc), expiresAt: device.expiresAt } }
        } catch (error) {
          // 解密失败(换过 SETTINGS_ENCRYPTION_KEY)→ 当作已用,让用户重新取链接。
          console.warn('[chat-access] 幂等窗口解密失败:', (error as Error).message)
        }
      }
    }
    // 出了窗口就把密文擦掉,别让它在库里长留。
    if (invite.deviceTokenEnc && !withinGrace) {
      await db.update(prChatInvites).set({ deviceTokenEnc: null }).where(eq(prChatInvites.id, invite.id))
    }
    return { ok: false, reason: 'used' }
  }

  if (invite.expiresAt.getTime() <= now) return { ok: false, reason: 'expired' }

  const { id: deviceId, grant } = await grantDevice(label?.slice(0, 200) || null, invite.id)

  // 幂等窗口需要能原样返回同一枚令牌 → 密文暂存,窗口过后由上面的分支清掉。
  let deviceTokenEnc: string | null = null
  try {
    deviceTokenEnc = encryptValue(grant.token)
  } catch (error) {
    // SETTINGS_ENCRYPTION_KEY 未配 → 放弃幂等窗口,兑换本身照常成功。
    console.warn('[chat-access] 无法加密设备令牌,幂等窗口不可用:', (error as Error).message)
  }

  await db
    .update(prChatInvites)
    .set({ usedAt: new Date(), deviceId, deviceTokenEnc })
    .where(eq(prChatInvites.id, invite.id))

  return { ok: true, grant }
}

/** 校验设备令牌。命中返回 deviceId,供中间件随后做滑动续期。 */
export async function verifyChatDeviceToken(token: string): Promise<string | null> {
  if (!token) return null

  const hash = hashToken(token)
  const cached = verifyCache.get(hash)
  if (cached && cached.cachedUntil > Date.now()) return cached.deviceId

  const db = await getActivitiesDb()
  const [device] = await db.select().from(prChatDevices).where(eq(prChatDevices.tokenHash, hash)).limit(1)
  if (!device || device.revokedAt || device.expiresAt.getTime() <= Date.now()) {
    verifyCache.delete(hash)
    return null
  }

  verifyCache.set(hash, { deviceId: device.id, cachedUntil: Date.now() + VERIFY_CACHE_TTL_MS })
  return device.id
}

/** 记一次使用并滑动续期(有节流,不是每请求都写库)。 */
export async function touchChatDevice(deviceId: string): Promise<void> {
  const now = Date.now()
  const last = lastTouchAt.get(deviceId) ?? 0
  if (now - last < TOUCH_INTERVAL_MS) return
  lastTouchAt.set(deviceId, now)

  try {
    const db = await getActivitiesDb()
    await db
      .update(prChatDevices)
      .set({ lastUsedAt: new Date(now), expiresAt: new Date(now + DEVICE_TTL_MS) })
      .where(eq(prChatDevices.id, deviceId))
  } catch (error) {
    // 续期失败不该让请求 500 —— 令牌本身已校验通过。
    console.warn('[chat-access] 设备令牌续期失败:', (error as Error).message)
  }
}

/** 吊销一台设备。返回是否命中。 */
export async function revokeChatDevice(deviceId: string): Promise<boolean> {
  const db = await getActivitiesDb()
  const [device] = await db.select().from(prChatDevices).where(eq(prChatDevices.id, deviceId)).limit(1)
  if (!device) return false

  if (!device.revokedAt) {
    await db.update(prChatDevices).set({ revokedAt: new Date() }).where(eq(prChatDevices.id, deviceId))
  }
  // 缓存以哈希为键、这里只有 id,直接整体清空(单用户场景代价可忽略,换来吊销即时生效)。
  verifyCache.clear()
  lastTouchAt.delete(deviceId)
  return true
}

/** 链接列表(不含明文/摘要),供管理端查看签发与使用情况。 */
export async function listChatInvites(limit = 50) {
  const db = await getActivitiesDb()
  const rows = await db.select().from(prChatInvites).orderBy(desc(prChatInvites.createdAt)).limit(limit)
  const now = Date.now()
  return rows.map(r => ({
    id: r.id,
    note: r.note,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt,
    deviceId: r.deviceId,
    status: r.usedAt ? 'used' : r.expiresAt.getTime() <= now ? 'expired' : 'pending',
  }))
}

/** 设备列表(不含明文/摘要)。 */
export async function listChatDevices(limit = 50) {
  const db = await getActivitiesDb()
  const rows = await db.select().from(prChatDevices).orderBy(desc(prChatDevices.createdAt)).limit(limit)
  const now = Date.now()
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    inviteId: r.inviteId,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    status: r.revokedAt ? 'revoked' : r.expiresAt.getTime() <= now ? 'expired' : 'active',
  }))
}
