/**
 * 通知派发(P4a:替换 P3a stub 为真实实现)。
 *
 * 从源仓 src/lib/notifications/dispatcher.ts 移植:读 notification_deliveries 的 pending/failed 行、
 * 乐观锁认领(locked_by/locked_until)、经"当前配置的渠道"发送、标记 sent/failed。
 *
 * 与源仓的差异(design §4 可插拔化):
 * - 渠道从硬编 pushplus 改为 NotificationChannel 接口(resolveChannel 选当前可用渠道)。
 * - 无可用渠道(PUSHPLUS_TOKEN 未配)→ 优雅跳过并 warn,不认领、不抛错、不误标 failed。
 * - 链接从 admin app_settings 改为 env(PUBLIC_BASE_URL)构造,去掉原硬编回退域名;不再带访问令牌。
 */
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { notificationDeliveries } from '@/lib/db/schema'

import { getPushPlusChannel } from './pushplus'
import type { NotificationChannel } from './types'

export interface NotificationDispatchResult {
  claimed: number
  sent: number
  failed: number
  skipped: number
}

const LOCK_TTL_MS = 2 * 60 * 1000
const MAX_ATTEMPTS = 3

function nextRetry(attempts: number) {
  const delayMinutes = Math.min(60, Math.max(1, attempts) * 5)
  return new Date(Date.now() + delayMinutes * 60 * 1000)
}

/**
 * 选出当前可用的通知渠道。目前只有 pushplus(gated on PUSHPLUS_TOKEN);
 * 未来新增渠道在此按优先级/配置挑选。无可用渠道返回 null。
 */
function resolveChannel(): NotificationChannel | null {
  return getPushPlusChannel()
}

/**
 * H5 对话入口链接:PUBLIC_BASE_URL(可空,留空则为相对路径)+ `/pr`,**不带令牌**。
 *
 * Reason: 原先拼的是 `?t=<PR_CHAT_TOKEN>` —— 那枚长期共享令牌于是被写进每一条推送,
 * 在推送服务端(PushPlus)的消息体里长期留存。现在设备令牌存在手机本地,链接只需
 * 把人带到对话页;设备令牌过期后去管理端签一条一次性链接(见 lib/pr/chat-access.ts)。
 */
function buildChatLink(): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  return `${base}/pr`
}

async function claimPending(limit: number, workerId: string) {
  const db = await getActivitiesDb()
  const now = new Date()
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        inArray(notificationDeliveries.status, ['pending', 'failed']),
        lte(notificationDeliveries.attempts, MAX_ATTEMPTS - 1),
        or(
          isNull(notificationDeliveries.lockedBy),
          lte(notificationDeliveries.lockedUntil, now),
        ),
        or(
          isNull(notificationDeliveries.nextRetryAt),
          lte(notificationDeliveries.nextRetryAt, now),
        ),
      ),
    )
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(limit)

  const lockedUntil = new Date(Date.now() + LOCK_TTL_MS)
  for (const row of rows) {
    await db
      .update(notificationDeliveries)
      .set({ lockedBy: workerId, lockedUntil, status: 'pending', updatedAt: new Date() })
      .where(eq(notificationDeliveries.id, row.id))
  }

  return rows
}

export async function dispatchPendingNotifications(limit = 10): Promise<NotificationDispatchResult> {
  // Reason: 无渠道时不认领任何行,直接返回空结果,避免把 pending 误标 failed 或死循环重投。
  const channel = resolveChannel()
  if (!channel) {
    console.warn('[notify] 无可用通知渠道(PUSHPLUS_TOKEN 未配置),跳过派发')
    return { claimed: 0, sent: 0, failed: 0, skipped: 0 }
  }

  const db = await getActivitiesDb()
  const workerId = `worker_${Date.now().toString(36)}`
  const rows = await claimPending(limit, workerId)

  const result: NotificationDispatchResult = {
    claimed: rows.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  }

  for (const row of rows) {
    try {
      if (row.channel === channel.name) {
        const r = await channel.send({ title: row.title, content: row.content, link: buildChatLink() })
        if (!r.ok) throw new Error(r.error || '发送失败')
        result.sent++
        await db
          .update(notificationDeliveries)
          .set({
            status: 'sent',
            attempts: row.attempts + 1,
            providerMessageId: r.providerMessageId ?? null,
            lastError: null,
            errorCode: null,
            lockedBy: null,
            lockedUntil: null,
            nextRetryAt: null,
            sentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(notificationDeliveries.id, row.id))
        continue
      }

      // 渠道不匹配(如遗留的微信测试号行)→ 标记失败,避免死循环重投。
      result.skipped++
      await db
        .update(notificationDeliveries)
        .set({
          status: 'failed',
          attempts: row.attempts + 1,
          errorCode: 'unsupported_channel',
          lastError: `Unsupported channel: ${row.channel}`,
          lockedBy: null,
          lockedUntil: null,
          nextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(eq(notificationDeliveries.id, row.id))
    } catch (error) {
      const attempts = row.attempts + 1
      result.failed++
      await db
        .update(notificationDeliveries)
        .set({
          status: 'failed',
          attempts,
          errorCode: 'send_failed',
          lastError: error instanceof Error ? error.message : String(error),
          lockedBy: null,
          lockedUntil: null,
          nextRetryAt: attempts >= MAX_ATTEMPTS ? null : nextRetry(attempts),
          updatedAt: new Date(),
        })
        .where(eq(notificationDeliveries.id, row.id))
    }
  }

  return result
}
