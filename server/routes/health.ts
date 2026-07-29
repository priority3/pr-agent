/**
 * 健康域路由。
 * GET  /api/health         公开存活探针(P4 再挂 scheduler 引导,本阶段仅返回 ok)。
 * GET  /api/health/daily   最近每日健康指标(admin 会话)。
 * POST /api/health/daily   Apple 健康快捷指令上报入口(admin 会话 或 Bearer HEALTH_IMPORT_TOKEN)。
 *
 * 移植自原仓 src/app/api/health/{route,daily/route}.ts;丢弃诊断用 connectivity(design 定弃)。
 */
import { Hono } from 'hono'

import { dispatchPendingNotifications } from '@/lib/notifications/dispatcher'
import { generateDailyReview } from '@/lib/pr/daily'
import { deriveSleep } from '@/lib/pr/health-derive'
import { getLatestHealthDailyMetrics, upsertHealthDailyMetric } from '@/lib/pr/health'
import { projectFriendProfile } from '@/lib/pr/memory'
import { withAuth, withHealthImportAuth } from '@/middleware/auth'

const health = new Hono()

// 公开存活探针。P0 骨架的等价物,scheduler 引导留到 P4。
health.get('/', c => c.json({ status: 'ok', service: 'pr-agent', ts: Date.now() }))

/**
 * 把换行分隔的 segments 文本(每行 `stage|startISO|endISO|durSec`)解析成段对象。
 * Reason: iOS 快捷指令生成文本 blob 远比嵌套 JSON 数组可靠,故上报文本、服务端结构化。
 */
function parseSegmentsText(
  text: string,
): Array<{ stage: string; start: string; end: string; minutes?: number }> {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [stage = '', start = '', end = '', durRaw = ''] = line.split('|')
      const durSec = Number(durRaw)
      // 时间戳渲染失败时,时长(秒)是可靠回退。
      const minutes = Number.isFinite(durSec) && durSec > 0 ? durSec / 60 : undefined
      return { stage: stage.trim(), start: start.trim(), end: end.trim(), minutes }
    })
    .filter(s => s.stage && (s.minutes != null || (s.start && s.end)))
}

/** 宽松取数值字段,容忍来自快捷指令 JSON 的字符串。 */
function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

/** 校验 YYYY-MM-DD 日历日期(与 source 一起做幂等键)。 */
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Asia/Shanghai 今日 YYYY-MM-DD。
 * Reason: 上报端(iOS 快捷指令)可能不填 date;早晨的睡眠上报即"今天",默认按 CST 而非报 400。
 */
function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

health.get('/daily', withAuth, async c => {
  const limitParam = Number(c.req.query('limit') ?? 14)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 30) : 14
  const metrics = await getLatestHealthDailyMetrics(limit)
  return c.json({ metrics })
})

// POST 接受 admin 会话或 HEALTH_IMPORT_TOKEN(外部上报端,如 iOS 快捷指令 / HealthKit)。
health.post('/daily', withHealthImportAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // date 可选:上报端省略时默认今天(Asia/Shanghai)。
  const rawDate = typeof body.date === 'string' ? body.date.trim() : ''
  const date = rawDate || todayYmd()
  if (!isValidDate(date)) {
    return c.json({ error: 'date must be a valid YYYY-MM-DD string' }, 400)
  }

  // 两种上报形状都支持:
  // 1) 富(新快捷指令):原始 sleepSegments/napSegments —— 服务端派生聚合。
  // 2) 直(旧版):sleepMinutes/deepSleepMinutes/... 由调用端算好。
  const sleepSegments = Array.isArray(body.sleepSegments)
    ? body.sleepSegments
    : typeof body.sleepSegmentsText === 'string'
      ? parseSegmentsText(body.sleepSegmentsText)
      : null
  const hasSegments = Array.isArray(sleepSegments)
  const derived = hasSegments ? deriveSleep(sleepSegments, body.napSegments) : null

  // 睡眠新鲜度:醒来时间应是"今晨"。醒来距今 > 20 小时多半是没戴表/无新睡眠,快捷指令又报了旧数据
  // (HealthKit 返回最近可用样本)。此时睡眠摘要置空(恢复标签变 unknown),让 PR 明说"没读到昨晚睡眠",
  // 而不是复述前一天数字。原始 segments 仍留 payload 供追溯。
  const SLEEP_STALE_MS = 20 * 60 * 60 * 1000
  const wakeMs = derived?.wakeTime ? new Date(derived.wakeTime).getTime() : null
  const sleepStale = wakeMs != null && Number.isFinite(wakeMs) && Date.now() - wakeMs > SLEEP_STALE_MS

  const audioAvgDb = toNumberOrNull(body.audioAvgDb ?? body.envAudioDb ?? body.environmentalAudioDb)
  const audioMaxDb = toNumberOrNull(body.audioMaxDb)

  // 原始事实 + 服务端派生额外项一并存 payload,供 PR agent 就此对话(入睡/醒来/觉醒次数/分段时间线/小睡/音量峰值)。
  const payload = hasSegments
    ? {
        sleepSegments,
        napSegments: Array.isArray(body.napSegments) ? body.napSegments : [],
        audio: { avgDb: audioAvgDb, maxDb: audioMaxDb },
        derived: derived
          ? {
              napMinutes: derived.napMinutes,
              coreMinutes: derived.coreMinutes,
              inBedMinutes: derived.inBedMinutes,
              awakeMinutes: derived.awakeMinutes,
              awakenings: derived.awakenings,
              bedtime: derived.bedtime,
              wakeTime: derived.wakeTime,
              stale: sleepStale,
            }
          : undefined,
      }
    : (body.payload ?? null)

  const metric = await upsertHealthDailyMetric({
    date,
    // Reason: 睡眠数据过期(见上)→ 摘要置空,不把旧数据当昨晚。
    sleepMinutes: sleepStale ? null : derived ? derived.sleepMinutes : toNumberOrNull(body.sleepMinutes),
    deepSleepMinutes: sleepStale ? null : derived ? derived.deepSleepMinutes : toNumberOrNull(body.deepSleepMinutes),
    remSleepMinutes: sleepStale ? null : derived ? derived.remSleepMinutes : toNumberOrNull(body.remSleepMinutes),
    hrv: toNumberOrNull(body.hrv),
    restingHr: toNumberOrNull(body.restingHr),
    steps: toNumberOrNull(body.steps),
    envAudioDb: audioAvgDb,
    source: typeof body.source === 'string' && body.source.trim() ? body.source.trim() : undefined,
    payload,
  })

  // Reason: 画像投影是下游附加动作,失败不得让上报失败,否则上报端会重试并以为上传丢了。
  try {
    await projectFriendProfile()
  } catch (error) {
    console.warn('[health/daily] projectFriendProfile failed:', (error as Error).message)
  }

  // Reason: 新鲜健康数据落库即触发当日反思(绑定该记录日期),事件驱动而非固定 cron 时钟,
  // 用户真正醒来上报后几秒内 PR 就反思当天。非阻塞:不把上报端挂在 AI 调用上。生成成功即分发通知
  // (不等每 10 分钟定时任务)。派发在 P4 前为 no-op stub。
  void generateDailyReview({ date })
    .then(async result => {
      if (result?.generated) {
        await dispatchPendingNotifications(5)
      }
    })
    .catch(error =>
      console.warn('[health/daily] daily reflection/dispatch failed:', (error as Error).message),
    )

  return c.json({ metricId: metric.id, metric })
})

export default health
