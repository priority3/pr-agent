/**
 * H5 只读数据接口(挂在 /api/pr/data 下)。
 *
 * 为什么单独一个文件而不是塞进 routes/pr.ts:那支已经有 500 行对话/SSE/上传,
 * 这里是纯查询(训练记录、单条详情、账号与数据概况),读写路径完全不同,分开更好改。
 *
 * 鉴权统一用 withPrChatAuth(设备令牌)——H5 页面只有一次性链接换来的设备令牌,
 * 拿不到 admin 会话;而 routes/pr.ts 里 /memories、/profile 那批走的是 withAuth,
 * 设备令牌访问会 401。所以这里的接口必须自己开,不能复用管理端点。
 *
 * 端点:
 *   GET    /api/pr/data/records            列表 + 本周汇总(周一为一周起点)
 *   GET    /api/pr/data/records/export.csv 导出 CSV(记录 + 分段两段)
 *   GET    /api/pr/data/records/:id        单条详情(含分段与 PR 点评)
 *   GET    /api/pr/data/account            访问设备 / 数据量 / 数据源
 *   DELETE /api/pr/data/threads            清空全部对话
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'

import { getDb } from '@/lib/db/client'
import {
  activities,
  activityReviews,
  conversationMessages,
  conversationThreads,
  memoryItems,
  prChatDevices,
  splits,
} from '@/lib/db/schema'
import { verifyChatDeviceToken } from '@/lib/pr/chat-access'
import { withPrChatAuth } from '@/middleware/auth'

const data = new Hono()

/** 一周从周一开始(设计稿的柱状图是一~日);返回本地时区的周一 00:00。 */
function startOfWeek(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // getDay():周日 0、周一 1 …… 周六 6;往回退到周一
  const offset = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - offset)
  return d
}

function csvCell(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

// ── 列表 ───────────────────────────────────────────────────────────────
data.get('/records', withPrChatAuth, async c => {
  const rawLimit = Number(c.req.query('limit') ?? 60)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 60

  const db = await getDb()
  const weekStart = startOfWeek()

  // 列表与本周汇总是两条查询:列表要 limit,汇总必须覆盖整周(否则一周超过 limit 条就少算)
  const [rows, weekRows] = await Promise.all([
    db
      .select({
        id: activities.id,
        title: activities.title,
        type: activities.type,
        startTime: activities.startTime,
        distance: activities.distance,
        duration: activities.duration,
        averagePace: activities.averagePace,
        averageHeartRate: activities.averageHeartRate,
        maxHeartRate: activities.maxHeartRate,
        elevationGain: activities.elevationGain,
      })
      .from(activities)
      .orderBy(desc(activities.startTime))
      .limit(limit),
    db
      .select({ distance: activities.distance, startTime: activities.startTime })
      .from(activities)
      .where(gte(activities.startTime, weekStart)),
  ])

  // 有没有点评单独查一次,不用 leftJoin:一条活动理论上可能有不止一条 isCurrent 记录,
  // join 出来会让列表出现重复行。
  const ids = rows.map(r => r.id)
  const reviewRows = ids.length
    ? await db
        .select({ activityId: activityReviews.activityId })
        .from(activityReviews)
        .where(and(inArray(activityReviews.activityId, ids), eq(activityReviews.isCurrent, true)))
    : []
  const reviewed = new Set(reviewRows.map(r => r.activityId))

  // 周一~周日各一天的里程(米),没有记录的那天是 0
  const days = [0, 0, 0, 0, 0, 0, 0]
  let weekDistance = 0
  for (const row of weekRows) {
    const idx = (new Date(row.startTime).getDay() + 6) % 7
    days[idx] += row.distance
    weekDistance += row.distance
  }

  return c.json({
    week: {
      start: weekStart.toISOString(),
      count: weekRows.length,
      distance: weekDistance,
      days,
    },
    activities: rows.map(row => ({
      id: row.id,
      title: row.title,
      type: row.type,
      startTime: row.startTime.toISOString(),
      distance: row.distance,
      duration: row.duration,
      averagePace: row.averagePace,
      averageHeartRate: row.averageHeartRate,
      maxHeartRate: row.maxHeartRate,
      elevationGain: row.elevationGain,
      reviewed: reviewed.has(row.id),
    })),
  })
})

// ── 导出 CSV(必须定义在 :id 之前,否则 "export.csv" 会被当成 id)──────
data.get('/records/export.csv', withPrChatAuth, async c => {
  const db = await getDb()
  const rows = await db
    .select()
    .from(activities)
    .orderBy(desc(activities.startTime))
    .limit(5000)

  const ids = rows.map(r => r.id)
  // 分段一次性捞回来再按 activityId 归组,避免 N+1
  const splitRows = ids.length ? await db.select().from(splits).where(inArray(splits.activityId, ids)) : []
  const byActivity = new Map<string, typeof splitRows>()
  for (const s of splitRows) {
    const list = byActivity.get(s.activityId) ?? []
    list.push(s)
    byActivity.set(s.activityId, list)
  }

  const lines: string[] = [
    '# 训练记录',
    ['id', '日期', '标题', '类型', '距离(公里)', '时长(秒)', '平均配速(秒/公里)', '平均心率', '最大心率', '爬升(米)'].join(','),
  ]
  for (const r of rows) {
    lines.push(
      [
        r.id,
        new Date(r.startTime).toISOString(),
        r.title,
        r.type,
        (r.distance / 1000).toFixed(2),
        r.duration,
        r.averagePace ?? '',
        r.averageHeartRate ?? '',
        r.maxHeartRate ?? '',
        r.elevationGain ?? '',
      ].map(csvCell).join(','),
    )
  }

  lines.push('', '# 分段', ['activity_id', '公里', '用时(秒)', '配速(秒/公里)', '距离(米)', '心率'].join(','))
  for (const s of splitRows.sort((a, b) => a.kilometer - b.kilometer)) {
    lines.push(
      [s.activityId, s.kilometer, s.duration, s.pace, s.distance, s.averageHeartRate ?? ''].map(csvCell).join(','),
    )
  }

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(`\uFEFF${lines.join('\n')}\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pr-records-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
})

// ── 单条详情 ───────────────────────────────────────────────────────────
data.get('/records/:id', withPrChatAuth, async c => {
  const id = c.req.param('id')
  const db = await getDb()

  const rows = await db.select().from(activities).where(eq(activities.id, id)).limit(1)
  const activity = rows[0]
  if (!activity) return c.json({ error: 'Not found' }, 404)

  const [splitRows, reviewRows] = await Promise.all([
    db.select().from(splits).where(eq(splits.activityId, id)).orderBy(splits.kilometer),
    db
      .select({ content: activityReviews.content, createdAt: activityReviews.createdAt, kind: activityReviews.kind })
      .from(activityReviews)
      .where(and(eq(activityReviews.activityId, id), eq(activityReviews.isCurrent, true)))
      .orderBy(desc(activityReviews.createdAt))
      .limit(1),
  ])

  return c.json({
    activity: {
      id: activity.id,
      title: activity.title,
      type: activity.type,
      startTime: activity.startTime.toISOString(),
      distance: activity.distance,
      duration: activity.duration,
      averagePace: activity.averagePace,
      bestPace: activity.bestPace,
      averageHeartRate: activity.averageHeartRate,
      maxHeartRate: activity.maxHeartRate,
      elevationGain: activity.elevationGain,
      calories: activity.calories,
      source: activity.source,
      raceName: activity.raceName,
    },
    splits: splitRows.map(s => ({
      kilometer: s.kilometer,
      duration: s.duration,
      pace: s.pace,
      distance: s.distance,
      averageHeartRate: s.averageHeartRate,
    })),
    review: reviewRows[0]
      ? { content: reviewRows[0].content, createdAt: reviewRows[0].createdAt.toISOString(), kind: reviewRows[0].kind }
      : null,
  })
})

// ── 账号 / 数据概况 ────────────────────────────────────────────────────
data.get('/account', withPrChatAuth, async c => {
  const db = await getDb()

  const countRows = async (table: typeof activities | typeof splits | typeof conversationThreads | typeof memoryItems) => {
    const rows = await db.select({ n: sql<number>`count(*)` }).from(table)
    return Number(rows[0]?.n ?? 0)
  }

  const [activityCount, splitCount, threadCount, memoryCount, sources] = await Promise.all([
    countRows(activities),
    countRows(splits),
    countRows(conversationThreads),
    countRows(memoryItems),
    db
      .select({ source: activities.source, last: sql<number>`max(${activities.startTime})`, n: sql<number>`count(*)` })
      .from(activities)
      .groupBy(activities.source),
  ])

  // 设备信息:中间件只做校验不暴露 deviceId,这里自己再解析一次令牌(同一枚,幂等查询)
  let device: { createdAt: string; lastUsedAt: string | null; expiresAt: string } | null = null
  const header = c.req.header('authorization') ?? ''
  if (header.startsWith('Bearer ')) {
    const deviceId = await verifyChatDeviceToken(header.slice(7).trim()).catch(() => null)
    if (deviceId) {
      const rows = await db
        .select({
          createdAt: prChatDevices.createdAt,
          lastUsedAt: prChatDevices.lastUsedAt,
          expiresAt: prChatDevices.expiresAt,
        })
        .from(prChatDevices)
        .where(eq(prChatDevices.id, deviceId))
        .limit(1)
      const row = rows[0]
      if (row) {
        device = {
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
          expiresAt: row.expiresAt.toISOString(),
        }
      }
    }
  }

  return c.json({
    device,
    counts: {
      activities: activityCount,
      splits: splitCount,
      threads: threadCount,
      memories: memoryCount,
    },
    sources: sources.map(s => ({
      source: s.source,
      count: Number(s.n),
      // startTime 是 timestamp 模式(库里存 Unix 秒),裸 sql 聚合拿回来是秒,要 ×1000
      lastAt: s.last ? new Date(Number(s.last) * 1000).toISOString() : null,
    })),
  })
})

// ── 清空全部对话 ───────────────────────────────────────────────────────
// 单条删除走 routes/pr.ts 的 DELETE /threads?id=;这里是「危险区」的整体清空。
data.delete('/threads', withPrChatAuth, async c => {
  const db = await getDb()
  const before = await db.select({ n: sql<number>`count(*)` }).from(conversationThreads)
  // 先删消息再删会话:与 deleteConversationThread 一致,不依赖 FK 级联
  await db.delete(conversationMessages)
  await db.delete(conversationThreads)
  return c.json({ deleted: Number(before[0]?.n ?? 0) })
})

export default data
