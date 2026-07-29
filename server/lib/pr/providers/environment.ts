/**
 * 环境感知 provider:天气实况/预报、空气质量、时刻与日出日落 —— PR 回答
 * 「今天适合跑步吗」缺失的"身体之外"维度。设计:claudedocs/pr-agent-environment-context-design.md
 *
 * 地点:无手机定位,用「常跑地点」近似 —— friend_profile.home_location_json 的显式
 * 设置优先(PR 伙伴面板维护);否则从最近室外活动的 GPX 起点聚类推导(0.02°≈2km 网格取众数)。
 * 数据:Open-Meteo forecast + air-quality(免费无 key,与活动回填天气同厂)。
 * 红线:查不到就渲染「暂无」,绝不让模型在无数据时输出环境数值。
 * 评测:PR_ENV_FIXTURE_JSON 注入 fixture,隔离评测不依赖真实外网(可复现)。
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { activities } from '@/lib/db/schema'
import { calculateDistance } from '@/lib/utils'
import {
  fetchCurrentAirQuality,
  fetchForecast,
  geocodeCity,
  type AirQualityData,
  type ForecastData,
  type ForecastHour,
} from '@/lib/weather/open-meteo'

import { getExplicitHomeLocation } from '../home-location'

import type { ContextBlock, ContextProvider } from './types'

/** 次要常跑点(众数簇之外、占比够高的簇)。 */
export interface HomeLocationAlternate {
  lat: number
  lng: number
  /** 该簇点数 / 采样点数(0-1)。 */
  share: number
}

export interface HomeLocation {
  lat: number
  lng: number
  /** 呈现给模型的地点措辞,如「按你配置的家附近」「按常跑路线定位」。 */
  label: string
  /** 来源:explicit=面板显式设置;derived=活动轨迹推导;fixture=评测注入。 */
  source?: 'explicit' | 'derived' | 'fixture'
  /** 推导所用主簇里最新一条活动的时间(epoch ms)——判断这个坐标还算不算「当下」。 */
  derivedFromLatestAt?: number
  /** 推导数据是否已过期(主簇最新活动早于 STALE_AFTER_DAYS)。 */
  stale?: boolean
  /** 采样到的轨迹起点总数。 */
  sampleSize?: number
  /** 主簇点数。 */
  clusterSize?: number
  /** 除主簇外还常去的地点(占比 ≥ ALTERNATE_MIN_SHARE)。 */
  alternates?: HomeLocationAlternate[]
}

interface EnvPayload {
  location: HomeLocation
  forecast: ForecastData
  airQuality: AirQualityData | null
}

interface EnvFixture {
  location?: HomeLocation
  forecast: ForecastData
  airQuality?: AirQualityData | null
  /** 固定"现在"(YYYY-MM-DDTHH:mm),让评测输出可复现。 */
  nowLocal?: string
  /** 评测用:按地名预置的异地预报(query_weather 的 place 参数在 fixture 模式下查这里,不出外网)。 */
  placeForecasts?: Record<string, ForecastData>
}

const LOCATION_TTL_MS = 6 * 60 * 60 * 1000
/** 推导采样:最近 N 条有轨迹的户外活动起点。 */
const DERIVE_SAMPLE_LIMIT = 12
/** 聚类网格边长(度),0.02° ≈ 2 km。 */
const CLUSTER_GRID_DEG = 0.02
/**
 * 推导数据超过这么多天就算「过期」:坐标照用,但要让模型知道这是旧轨迹推的、可能已经变了。
 * Reason: 刻意写成代码常量而不是设置项/env——地点新鲜度是判断逻辑而非用户偏好,
 * 多一个开关就多一个要维护的设定。90 天 ≈ 一个季度,足够跨过搬家/换城市/换训练场这类变化。
 */
const STALE_AFTER_DAYS = 90
/** 次要簇入选门槛(占采样点数的比例);低于此视为偶发外地跑,不呈现。 */
const ALTERNATE_MIN_SHARE = 0.25
/**
 * 次要簇与主簇至少要隔这么远才算「另一个地点」(km)。
 * Reason: 网格聚类会把同一片区域跨格切成两簇(起点在格子边界上抖动),
 * 隔得太近的簇其实是同一个地方,列成「也常去」只会给模型添噪声。
 */
const ALTERNATE_MIN_SEPARATION_KM = 1.5
const ENV_TTL_MS = 45 * 60 * 1000
const ENV_FAIL_TTL_MS = 5 * 60 * 1000 // 失败也缓存,但短——瞬时抖动不该把「暂无」钉 45 分钟

let locationCache: { at: number; value: HomeLocation | null } | null = null
let envCache: { at: number; value: EnvPayload | null } | null = null

function readFixture(): EnvFixture | null {
  const raw = process.env.PR_ENV_FIXTURE_JSON
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as EnvFixture
    return parsed && typeof parsed === 'object' && parsed.forecast ? parsed : null
  } catch (error) {
    console.warn('[pr-env] PR_ENV_FIXTURE_JSON 解析失败,忽略 fixture:', (error as Error).message)
    return null
  }
}

function validCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/**
 * fixture 地点归一:缺 source 就按 'fixture' 记。
 * Reason: 新增的新鲜度/多点字段默认缺省 → 评测渲染与改动前逐字一致(可复现性优先);
 * 要考「过期地点」「两个常跑点」这类行为时,fixture 里显式带上 source/stale/alternates 即可。
 */
function fixtureLocation(fixture: EnvFixture): HomeLocation {
  const location = fixture.location ?? { lat: 0, lng: 0, label: '按评测 fixture' }
  return { ...location, source: location.source ?? 'fixture' }
}

/** 推导输入:一条活动的起点 + 该活动开始时间(新鲜度判断用)。 */
export interface DerivePoint {
  lat: number
  lng: number
  /** 活动开始时间(epoch ms)。 */
  at: number
}

/** 「12 天」「9 个月」「1.5 年」这类口语时长(给模型措辞用,别把裸时间戳递出去)。 */
function agoText(ms: number): string {
  const days = Math.max(0, Math.round(ms / 86_400_000))
  if (days < 45) return `${days} 天`
  if (days < 365) return `${Math.round(days / 30)} 个月`
  return `${(days / 365).toFixed(1)} 年`
}

function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return calculateDistance({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }) / 1000
}

/**
 * 起点聚类 → 常跑地点。纯函数(无 DB/无时钟),推导规则集中在这里也便于单测。
 * - 0.02°(≈2 km)网格分簇,众数簇均值 = 主常跑点(排除偶尔的外地跑)。
 * - 占比 ≥ ALTERNATE_MIN_SHARE 且与主簇隔开 ALTERNATE_MIN_SEPARATION_KM 的簇 = 「也常去」。
 * - 新鲜度按**主簇**里最新一条活动算:主簇很久没出现,说明这坐标未必还是他现在常跑的地方
 *   (整批点里的最新一条可能来自别的簇,不能代表这个坐标的新鲜度)。
 */
export function deriveLocationFromPoints(points: DerivePoint[], now = Date.now()): HomeLocation | null {
  if (points.length === 0) return null

  const buckets = new Map<string, DerivePoint[]>()
  for (const point of points) {
    const key = `${Math.round(point.lat / CLUSTER_GRID_DEG)}:${Math.round(point.lng / CLUSTER_GRID_DEG)}`
    const bucket = buckets.get(key) ?? []
    bucket.push(point)
    buckets.set(key, bucket)
  }
  // 点数相同时按插入序取胜(sort 稳定 + Map 保序);调用方按时间倒序喂点 → 平票偏向最近去的那处。
  const clusters = Array.from(buckets.values()).sort((a, b) => b.length - a.length)
  const center = (cluster: DerivePoint[]) => ({
    lat: cluster.reduce((sum, p) => sum + p.lat, 0) / cluster.length,
    lng: cluster.reduce((sum, p) => sum + p.lng, 0) / cluster.length,
  })

  const [dominant, ...rest] = clusters
  const main = center(dominant)
  const latestAt = Math.max(...dominant.map(point => point.at))
  const stale = now - latestAt > STALE_AFTER_DAYS * 86_400_000
  const alternates = rest
    .filter(cluster => cluster.length / points.length >= ALTERNATE_MIN_SHARE)
    .map(cluster => ({ ...center(cluster), share: cluster.length / points.length }))
    .filter(alternate => distanceKm(main, alternate) >= ALTERNATE_MIN_SEPARATION_KM)

  return {
    ...main,
    // 过期时把「多久以前」写进 label:label 会进上下文标题与 query_weather 返回,
    // 模型光看这一处就知道该给结论留余地。
    label: stale ? `按 ${agoText(now - latestAt)}前的常跑路线推定` : '按常跑路线定位',
    source: 'derived',
    derivedFromLatestAt: latestAt,
    ...(stale ? { stale: true } : {}),
    sampleSize: points.length,
    clusterSize: dominant.length,
    ...(alternates.length ? { alternates } : {}),
  }
}

/** 从最近室外活动的路线起点推导常跑地点(众数网格的均值 + 新鲜度 + 次要常跑点)。 */
async function deriveLocationFromActivities(): Promise<HomeLocation | null> {
  const db = await getActivitiesDb()
  // Reason: routeCoordinates 是整条降采样路线的 JSON,整列取回太重;
  // 起点必在开头,substr 前 64 字符足够正则出第一对 [lat,lng]。
  const columns = {
    head: sql<string>`substr(${activities.routeCoordinates}, 1, 64)`,
    startTime: activities.startTime,
  }
  const baseWhere = [eq(activities.isIndoor, false), isNotNull(activities.routeCoordinates)]
  let rows = await db
    .select(columns)
    .from(activities)
    .where(and(eq(activities.type, 'running'), ...baseWhere))
    .orderBy(desc(activities.startTime))
    .limit(DERIVE_SAMPLE_LIMIT)
  if (rows.length === 0) {
    // 没有室外跑步就放宽到任意室外活动(骑行/步行起点同样能定位生活范围)
    rows = await db
      .select(columns)
      .from(activities)
      .where(and(...baseWhere))
      .orderBy(desc(activities.startTime))
      .limit(DERIVE_SAMPLE_LIMIT)
  }

  const points: DerivePoint[] = []
  for (const row of rows) {
    const match = /\[\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(row.head ?? '')
    if (!match) continue
    const lat = Number(match[1])
    const lng = Number(match[2])
    // Reason: 时间拿不到的点直接丢掉——新鲜度是这次改动的承重字段,
    // 让一个没有时间的点混进簇会把 latestAt 算歪(宁可少一个采样点)。
    // 包一层 new Date 而不是直接 .getTime():drizzle timestamp 模式给的是 Date,
    // 但驱动层回退成数字/字符串时也能吃(拿不到就 NaN → 这条被过滤)。
    const at = new Date(row.startTime).getTime()
    if (validCoord(lat, lng) && Number.isFinite(at)) points.push({ lat, lng, at })
  }
  return deriveLocationFromPoints(points)
}

/**
 * 常跑地点(显式设置优先,否则活动起点聚类;带 TTL 缓存)。
 * 导出给 activities provider 算 startPlace(起点相对常跑地点的方位),别处也可复用。
 */
export async function getHomeLocation(): Promise<HomeLocation | null> {
  // Reason: fixture 模式(评测)地点也以 fixture 为准——startPlace 等派生值可复现,
  // 不受评测机真实画像库里显式地点的影响;生产无 fixture,此分支不生效。
  const fixture = readFixture()
  if (fixture?.location) return fixtureLocation(fixture)
  if (locationCache && Date.now() - locationCache.at < LOCATION_TTL_MS) return locationCache.value

  let value: HomeLocation | null = null
  // 显式值读 friend_profile.home_location_json(画像数据);坏数据/未设置由 helper 归一成 null。
  const explicit = await getExplicitHomeLocation().catch(() => null)
  if (explicit) {
    value = {
      lat: explicit.lat,
      lng: explicit.lng,
      label: explicit.label ? `按${explicit.label}` : '按你设置的常跑地点',
      source: 'explicit',
    }
  } else {
    value = await deriveLocationFromActivities().catch(() => null)
  }
  locationCache = { at: Date.now(), value }
  return value
}

/**
 * 清空常跑地点缓存与环境快照缓存。
 * Reason: 面板保存/清除显式地点后调用,同进程下一次构建上下文立即用新地点——
 * 环境快照(envCache)里嵌着旧地点的天气,所以两个缓存必须一起清,不能只清 locationCache。
 */
export function invalidateHomeLocationCache(): void {
  locationCache = null
  envCache = null
}

async function getEnvPayload(): Promise<EnvPayload | null> {
  const fixture = readFixture()
  if (fixture) {
    return {
      location: fixtureLocation(fixture),
      forecast: fixture.forecast,
      airQuality: fixture.airQuality ?? null,
    }
  }
  if (envCache) {
    const ttl = envCache.value ? ENV_TTL_MS : ENV_FAIL_TTL_MS
    if (Date.now() - envCache.at < ttl) return envCache.value
  }

  let value: EnvPayload | null = null
  const location = await getHomeLocation()
  if (location) {
    // AQI 失败可容忍(单独 null),forecast 失败则整体降级为「暂无」
    const [forecast, airQuality] = await Promise.all([
      fetchForecast(location.lat, location.lng),
      fetchCurrentAirQuality(location.lat, location.lng).catch(() => null),
    ])
    if (forecast) value = { location, forecast, airQuality }
  }
  envCache = { at: Date.now(), value }
  return value
}

// ─── 渲染 ───────────────────────────────────────────────────────────────────

function shanghaiNowLocal(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

function timeBucket(hour: number) {
  if (hour >= 5 && hour < 9) return '清晨'
  if (hour >= 9 && hour < 12) return '上午'
  if (hour >= 12 && hour < 14) return '午间'
  if (hour >= 14 && hour < 18) return '下午'
  if (hour >= 18 && hour < 22) return '晚间'
  return '夜间'
}

/** 降雨/降雪类 WMO code(与 open-meteo.ts 的描述表同源语义)。 */
function isWetCode(code: number) {
  return (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || code >= 95
}

function summarizeNext12h(hours: ForecastHour[]): string {
  if (hours.length === 0) return '- 未来 12 小时：暂无逐小时预报'
  const wet = hours.filter(hour => (hour.precipitationProbability ?? 0) >= 40 || isWetCode(hour.weatherCode))
  if (wet.length === 0) {
    const temps = hours.map(hour => hour.temperature)
    return `- 未来 12 小时：无明显降水，气温 ${Math.round(Math.min(...temps))}-${Math.round(Math.max(...temps))}°C`
  }
  const firstHour = Number(wet[0].timeLocal.slice(11, 13))
  const lastHour = Number(wet[wet.length - 1].timeLocal.slice(11, 13))
  const maxProb = Math.max(...wet.map(hour => hour.precipitationProbability ?? 0))
  const desc = wet.find(hour => isWetCode(hour.weatherCode))?.description ?? '降水'
  const span = firstHour === lastHour ? `${firstHour} 点前后` : `${firstHour}-${lastHour} 点`
  return `- 未来 12 小时：${span}可能有${desc}${maxProb > 0 ? `（概率最高 ${maxProb}%）` : ''}`
}

function renderEnvironmentLines(payload: EnvPayload, nowLocal: string): string[] {
  const clock = nowLocal.slice(11, 16)
  const hour = Number(nowLocal.slice(11, 13))
  const today = payload.forecast.daily.find(day => day.date === nowLocal.slice(0, 10)) ?? payload.forecast.daily[0]

  let sunNote = ''
  if (today) {
    if (clock < today.sunrise) sunNote = `，日出 ${today.sunrise}，天还没亮`
    else if (clock < today.sunset) sunNote = `，日落 ${today.sunset}`
    else sunNote = `，日落 ${today.sunset}，天已黑`
  }

  const cur = payload.forecast.current
  const next12 = payload.forecast.hourly.filter(hourItem => hourItem.timeLocal > nowLocal).slice(0, 12)
  const lines = [
    `- 现在：${clock}（${timeBucket(hour)}）${sunNote}`,
    `- 实况：${cur.temperature}°C（体感 ${cur.apparentTemperature}°C），${cur.description}，风 ${cur.windSpeed} km/h，湿度 ${cur.humidity}%`,
    summarizeNext12h(next12),
  ]
  if (payload.airQuality) {
    const air = payload.airQuality
    lines.push(`- 空气：AQI ${air.aqi}（${air.label}${air.pm25 != null ? `，PM2.5 ${air.pm25}` : ''}）`)
  }
  return lines
}

/**
 * 地点自身的可信度说明(渲染在环境数据之后)。三种情形各一行,都不成立就不占字:
 * ① 推导数据过期 → 别把旧轨迹当成他当下的位置,天气结论要留余地;
 * ② 有第二个常跑点 → 让模型知道不止一处(天气仍按主簇,避免歧义);
 * ③ 只有坐标没地名 → 不许猜地名,可在聊到时顺口问一次(替代"再加一个设置项")。
 */
function locationCaveatLines(location: HomeLocation, now = Date.now()): string[] {
  const lines: string[] = []
  if (location.stale && location.derivedFromLatestAt) {
    lines.push(
      `- 位置存疑：这个坐标是从他有轨迹的跑步起点推出来的，其中最新那次已经是 ${agoText(now - location.derivedFromLatestAt)}前了——这段时间他可能换了常跑的地方、甚至换了城市。上面的天气/空气只对这个坐标成立：说的时候带上这层不确定（「按你常跑那边看…」），或者顺口确认一句他现在还在那边跑吗，别当成他此刻所在地的确定实况。`,
    )
  }
  if (location.alternates?.length) {
    const mainShare = location.sampleSize && location.clusterSize
      ? `约 ${Math.round((location.clusterSize / location.sampleSize) * 100)}%`
      : '大多数'
    const alts = location.alternates
      .map(
        alt =>
          `${alt.lat.toFixed(3)},${alt.lng.toFixed(3)}（约 ${Math.round(alt.share * 100)}%，离主要那处约 ${distanceKm(location, alt).toFixed(1)} km）`,
      )
      .join('；')
    lines.push(
      `- 常跑地点不止一处：主要那处（${mainShare} 的轨迹起点，也就是上面天气用的坐标）之外，他还常去 ${alts}。天气按主要那处算；别把「他只在一个地方跑」当成事实。坐标是给你自己判断用的，别念给他听。`,
    )
  }
  if (location.source === 'derived') {
    lines.push(
      '- 只有坐标、没有地名：系统没有地图检索能力，不知道这地方叫什么，所以公园名/路名/小区名一律别猜别编。长期记忆里若已有他说过的常跑地点名字，就直接用那个；没有的话，等聊到跑步地点或路线时可以顺口问一句他平时都在哪儿跑，问过一次就够了——别每轮都问，也别为了问打断正题。',
    )
  }
  return lines
}

/** 给 query_weather 返回用的一句话位置说明(工具 JSON 用半角标点,与其他 note 一致)。 */
function staleLocationCaveat(location: HomeLocation, now = Date.now()): string | null {
  if (!location.stale || !location.derivedFromLatestAt) return null
  return `地点说明:这不是他设置的地点,是按 ${agoText(now - location.derivedFromLatestAt)}前的跑步轨迹推的,未必还是他现在常跑的地方——这份天气要带着这层不确定说,别当成他当下位置的准确实况`
}

function unavailableBlock(reason: string): ContextBlock {
  return {
    key: 'environment',
    title: '# 现在的环境（实况与预报）',
    lines: [`- 暂无（${reason}；没有环境数据就别给天气/空气的具体数值）`],
    data: { hasEnvironment: false },
  }
}

// ─── Provider ───────────────────────────────────────────────────────────────

export const environmentProvider: ContextProvider = {
  key: 'environment',
  priority: 70,
  load: async () => {
    const payload = await getEnvPayload()
    if (!payload) {
      const location = await getHomeLocation().catch(() => null)
      return unavailableBlock(location ? '天气服务未响应' : '还没有可定位的常跑地点,可在 PR 伙伴面板设置')
    }
    const nowLocal = readFixture()?.nowLocal ?? shanghaiNowLocal()
    return {
      key: 'environment',
      title: `# 现在的环境（实况与预报，${payload.location.label}）`,
      lines: [...renderEnvironmentLines(payload, nowLocal), ...locationCaveatLines(payload.location)],
      data: {
        hasEnvironment: true,
        locationLabel: payload.location.label,
        locationSource: payload.location.source ?? null,
        locationStale: payload.location.stale ?? false,
      },
    }
  },
  tools: [
    {
      name: 'query_weather',
      description:
        '查天气(逐日概览+早晚时段),默认常跑地点,也可用 place 指定任意城市/地名(他出差/旅行/异地跑时用)。上下文快照只有当下和未来 12 小时;他问「明天早上」「周末」「比赛那天」这类更远时间、或问外地天气时用它。过去的日期也能查(近 3 个月内的当天实况,复盘那天用);未来超过 7 天、过去超过 3 个月的查不了,要如实说。',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD;省略则查明天' },
          place: { type: 'string', description: '城市/地名,如「上海」「杭州」;省略则用常跑地点' },
        },
      },
    },
  ],
  executeTool: async (_name, rawInput) => {
    const input = (rawInput ?? {}) as Record<string, unknown>
    const fixture = readFixture()
    const place = typeof input.place === 'string' && input.place.trim() ? input.place.trim() : null

    // 日期先行解析(nowLocal 不依赖预报数据):过去日期要决定真实路径带多大的 past_days。
    const nowLocal = fixture?.nowLocal ?? shanghaiNowLocal()
    const todayStr = nowLocal.slice(0, 10)
    const fallbackDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
      new Date(Date.parse(`${todayStr}T00:00:00+08:00`) + 86_400_000),
    )
    const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : fallbackDate
    // 过去日期:forecast API 的 past_days 能带回近 92 天的当天实况;更久的如实拒,别装能查。
    const daysAgo = date < todayStr ? Math.round((Date.parse(todayStr) - Date.parse(date)) / 86_400_000) : 0
    if (daysAgo > 92) {
      return JSON.stringify({
        error: `${date} 已经过去超过 3 个月,当天实况查不到了;那天如果有运动,query_activities 的记录里带当次实测天气`,
      })
    }
    const pastDays = daysAgo > 0 ? Math.min(daysAgo + 1, 92) : 0

    // 地点解析:place 指定异地(fixture 查预置表 / 真实走 geocoding),否则常跑地点。
    let forecast: ForecastData | null = null
    let locationLabel = ''
    // 常跑地点是旧轨迹推的时,把这层不确定一起返回给模型(place 指定异地时无此问题)。
    let locationCaveat: string | null = null
    if (place) {
      if (fixture) {
        const preset = fixture.placeForecasts?.[place]
        if (!preset) return JSON.stringify({ error: `查不到「${place}」的天气(换个更常见的城市名试试?)` })
        forecast = preset
        locationLabel = place
      } else {
        const geo = await geocodeCity(place)
        if (!geo) return JSON.stringify({ error: `没找到「${place}」这个地点,换个写法再试?` })
        forecast = await fetchForecast(geo.lat, geo.lng, 7, pastDays)
        if (!forecast) return JSON.stringify({ error: '天气服务没响应,稍后再试,别编数值' })
        locationLabel = geo.label
      }
    } else if (pastDays > 0 && !fixture) {
      // Reason: 快照缓存(getEnvPayload)只装未来预报,过去日期单独拉一次带 past_days 的数据,
      // 不动缓存——否则一次复盘会把 45 分钟的环境快照换成带历史的大包。fixture 路径不走这里:
      // 评测把过去日期的真值直接预置进 fixture.forecast.daily/hourly,下方 find 自然命中。
      const location = await getHomeLocation().catch(() => null)
      if (!location) return JSON.stringify({ error: '还没有常跑地点定位,查不了那天的天气,别编数值' })
      forecast = await fetchForecast(location.lat, location.lng, 7, pastDays)
      if (!forecast) return JSON.stringify({ error: '天气服务没响应,稍后再试,别编数值' })
      locationLabel = location.label
      locationCaveat = staleLocationCaveat(location)
    } else {
      const payload = await getEnvPayload()
      if (!payload) return JSON.stringify({ error: '天气服务不可用或还没有常跑地点定位,别编数值' })
      forecast = payload.forecast
      locationLabel = payload.location.label
      locationCaveat = staleLocationCaveat(payload.location)
    }

    const day = forecast.daily.find(item => item.date === date)
    if (!day) {
      const range = forecast.daily
      // 错误文案分叉:过去=「已过去、实测没拿到」;未来=「还没预报到」。语气别搞反(过去说"还查不了"像未来)。
      return JSON.stringify({
        error:
          date < todayStr
            ? `${date} 已经过去,那天的实况没查到(可查范围 ${range[0]?.date} ~ ${range[range.length - 1]?.date})`
            : `预报只覆盖 ${range[0]?.date} ~ ${range[range.length - 1]?.date},${date} 还查不了`,
      })
    }

    const hoursOf = (from: number, to: number) =>
      forecast!.hourly.filter(hour => {
        if (hour.timeLocal.slice(0, 10) !== date) return false
        const h = Number(hour.timeLocal.slice(11, 13))
        return h >= from && h <= to
      })
    const segment = (label: string, hours: ForecastHour[]) => {
      if (hours.length === 0) return null
      const temps = hours.map(hour => hour.temperature)
      return {
        label,
        tempRange: `${Math.round(Math.min(...temps))}-${Math.round(Math.max(...temps))}°C`,
        maxPrecipitationProbability: Math.max(...hours.map(hour => hour.precipitationProbability ?? 0)),
        description: hours.find(hour => isWetCode(hour.weatherCode))?.description ?? hours[0].description,
      }
    }
    return JSON.stringify({
      date,
      location: locationLabel,
      // 过去日期给措辞锚点:这是那天的实况回看,不是预报,模型别说成「预计」。
      // 地点过期时同一字段带上位置不确定(两条都可能出现,拼一起给)。
      note:
        [daysAgo > 0 ? '历史实测(那天已过去,以下是当天实况汇总)' : null, locationCaveat]
          .filter(Boolean)
          .join(';') || undefined,
      summary: {
        description: day.description,
        tempMin: day.tempMin,
        tempMax: day.tempMax,
        precipitationProbabilityMax: day.precipitationProbabilityMax,
        sunrise: day.sunrise,
        sunset: day.sunset,
      },
      morning: segment('清晨 6-9 点', hoursOf(6, 9)),
      evening: segment('傍晚 18-21 点', hoursOf(18, 21)),
    })
  },
}
