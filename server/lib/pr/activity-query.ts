/**
 * 活动记录查询(FactLoader + `query_activities` 工具执行体)—— 自 context.ts 拆出
 * (该文件逼近 500 行红线)。context.ts re-export 了这里的公开符号,既有调用方不受影响。
 *
 * 摘要列在原 6 列外补了 weatherData / elevationGain / 路线起点:库里早就有每次活动
 * 回填的实测天气与爬升,但此前被裁掉 → PR 复盘「20 号那次徒步」时只能拿今天天气顶替。
 */
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { activities } from '@/lib/db/schema'

export interface RecentActivityContext {
  date: string
  daysAgo: number
  type: string
  distanceKm: number
  durationMin: number
  paceText: string | null
  avgHeartRate: number | null
  /** 当次实测天气(活动同步时回填;缺失/坏数据 → null)。 */
  weather?: { temperature: number; description: string } | null
  /** 爬升(米);缺失 → null。 */
  elevationGainM?: number | null
  /** 路线起点坐标(供 startPlace 相对位置计算;无轨迹 → null)。 */
  startLatLng?: { lat: number; lng: number } | null
}

/** 秒/公里 → 5'29" 文本。先四舍五入到整秒再拆分,避免独立取整出现 5'60"。 */
function formatPace(secPerKm: number | null): string | null {
  if (!secPerKm || !Number.isFinite(secPerKm) || secPerKm <= 0) return null
  const total = Math.round(secPerKm)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}'${String(seconds).padStart(2, '0')}"`
}

/** activities 行 → 上下文条目(只依赖摘要列,不碰 GPX 大字段)。 */
type ActivitySummaryRow = {
  startTime: Date
  type: string
  distance: number
  duration: number
  averagePace: number | null
  averageHeartRate: number | null
  weatherData: string | null
  elevationGain: number | null
  routeHead: string | null
}

const ACTIVITY_SUMMARY_COLUMNS = {
  startTime: activities.startTime,
  type: activities.type,
  distance: activities.distance,
  duration: activities.duration,
  averagePace: activities.averagePace,
  averageHeartRate: activities.averageHeartRate,
  weatherData: activities.weatherData,
  elevationGain: activities.elevationGain,
  // Reason: routeCoordinates 是整条降采样路线的 JSON,整列取回太重;起点必在开头,
  // substr 前 64 字符足够正则出第一对 [lat,lng](同 environment.ts 的起点截取技巧)。
  routeHead: sql<string | null>`substr(${activities.routeCoordinates}, 1, 64)`,
}

/** 回填天气 JSON({ temperature, description, ... })→ 精简对象;坏数据一律 null,不抛。 */
function parseActivityWeather(raw: string | null): { temperature: number; description: string } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { temperature?: unknown; description?: unknown }
    if (typeof parsed?.temperature !== 'number' || !Number.isFinite(parsed.temperature)) return null
    return {
      temperature: parsed.temperature,
      description: typeof parsed.description === 'string' ? parsed.description : '',
    }
  } catch {
    return null
  }
}

/** 路线 JSON 头部 → 起点坐标;正则失配/越界坐标 → null,不抛。 */
function parseStartLatLng(head: string | null): { lat: number; lng: number } | null {
  const match = /\[\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(head ?? '')
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

function mapActivityRow(row: ActivitySummaryRow, fmt: Intl.DateTimeFormat, today: string): RecentActivityContext {
  const date = fmt.format(row.startTime)
  const daysAgo = Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000))
  const distanceKm = row.distance / 1000
  // Reason: Keep 摘要有时缺 averagePace,用距离/时长推导;但距离过小(GPS 抖动/误触的几十米"活动")
  // 推出的配速是垃圾还长得像真的,所以只在 ≥0.1km 时推导,更短的就不给配速。存量 averagePace 一律信。
  const paceSecPerKm = row.averagePace ?? (distanceKm >= 0.1 ? row.duration / distanceKm : null)
  return {
    date,
    daysAgo,
    type: row.type,
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMin: Math.round(row.duration / 60),
    paceText: formatPace(paceSecPerKm),
    avgHeartRate: row.averageHeartRate ?? null,
    weather: parseActivityWeather(row.weatherData),
    elevationGainM:
      row.elevationGain != null && Number.isFinite(row.elevationGain) ? Math.round(row.elevationGain) : null,
    startLatLng: parseStartLatLng(row.routeHead),
  }
}

/**
 * 通用运动记录查询——也是对话 agent `query_activities` 工具的执行体,
 * 模型可按类型过滤、用 before 往更早翻页、用 date 精确复盘某一天。
 * 日期按 Asia/Shanghai(与健康数据同键)。
 */
export async function queryActivityContext(
  input: { type?: string; before?: string; date?: string; limit?: number } = {},
): Promise<RecentActivityContext[]> {
  const db = await getActivitiesDb()
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 20)
  const conditions: SQL[] = []
  if (input.type) conditions.push(eq(activities.type, input.type))
  if (input.before && /^\d{4}-\d{2}-\d{2}$/.test(input.before)) {
    // before 语义:该日期(上海时区)当天 00:00 之前,配合返回里的 date 字段即可持续往前翻
    conditions.push(lt(activities.startTime, new Date(Date.parse(`${input.before}T00:00:00+08:00`))))
  }
  if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    // date 语义:该日期(上海时区)当天 [00:00, 24:00) —— 「复盘某天的活动」精确过滤,与 before 同套日期口径
    const dayStart = new Date(Date.parse(`${input.date}T00:00:00+08:00`))
    conditions.push(gte(activities.startTime, dayStart), lt(activities.startTime, new Date(dayStart.getTime() + 86_400_000)))
  }
  const rows = await db
    .select(ACTIVITY_SUMMARY_COLUMNS)
    .from(activities)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(activities.startTime))
    .limit(limit)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
  const today = fmt.format(new Date())
  return rows.map(row => mapActivityRow(row, fmt, today))
}

/**
 * 最近 N 次运动(FactLoader 之一,供对话引用真实跑步记录——此前对话只喂健康数据,
 * PR 会对"上次跑步"瞎猜)。
 */
export async function getRecentActivityContext(limit = 5): Promise<RecentActivityContext[]> {
  return queryActivityContext({ limit })
}

/**
 * 每种运动类型各自的最近一次。补"最近 N 条"窗口的盲区:比如最近连续骑行,
 * 跑步被挤出窗口,PR 会答"查不到跑步记录"——但对运动伙伴来说,
 * 「距上次跑步多久了」恰恰是最重要的事实。
 */
export async function getLatestActivityPerType(): Promise<RecentActivityContext[]> {
  const db = await getActivitiesDb()
  // 先取所有出现过的类型(基数极小:跑/骑/走…),再各查最近一条。
  // Reason: 不能"扫最近 N 条 + JS 去重"——若某类型全被更晚的其他类型挤到 N 条之外,就会漏掉它的最近一次。
  const typeRows = await db.selectDistinct({ type: activities.type }).from(activities)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
  const today = fmt.format(new Date())
  const perType = await Promise.all(
    typeRows.map(async ({ type }) => {
      const [row] = await db
        .select(ACTIVITY_SUMMARY_COLUMNS)
        .from(activities)
        .where(eq(activities.type, type))
        .orderBy(desc(activities.startTime))
        .limit(1)
      return row ? mapActivityRow(row, fmt, today) : null
    }),
  )
  return perType.filter((item): item is RecentActivityContext => item !== null)
}
