import { calculateDistance } from '@/lib/utils'

import {
  getLatestActivityPerType,
  getRecentActivityContext,
  queryActivityContext,
  type RecentActivityContext,
} from '../context'

import { getHomeLocation, type HomeLocation } from './environment'
import type { ContextProvider } from './types'

const TYPE_LABEL: Record<string, string> = { running: '跑步', cycling: '骑行', walking: '步行' }

function daysAgoLabel(days: number) {
  return days === 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`
}

function activityLine(act: RecentActivityContext) {
  // 存在才追加(控制 token):爬升 <50m 是噪声不值一提;当次天气缺失(未回填)就不占字。
  const climb = act.elevationGainM != null && act.elevationGainM >= 50 ? `，爬升 ${act.elevationGainM} m` : ''
  const weather = act.weather
    ? `，当时 ${act.weather.temperature}°C${act.weather.description ? ` ${act.weather.description}` : ''}`
    : ''
  return `- ${act.date}（${daysAgoLabel(act.daysAgo)}）：${TYPE_LABEL[act.type] ?? act.type} ${act.distanceKm} km，用时 ${act.durationMin} 分钟${act.paceText ? `，配速 ${act.paceText}/km` : ''}${act.avgHeartRate ? `，平均心率 ${act.avgHeartRate}` : ''}${climb}${weather}`
}

/**
 * 起点相对常跑地点的方位标签。刻意不做反地理编码(零外网新依赖、评测可复现):
 * 系统只给「常跑地点附近 / 离常跑地点约 N km」,真实地名(「龙泉山」)靠记忆/对话补。
 */
function startPlaceLabel(act: RecentActivityContext, home: HomeLocation | null): string | null {
  if (!home || !act.startLatLng) return null
  const km =
    calculateDistance({ lat: home.lat, lon: home.lng }, { lat: act.startLatLng.lat, lon: act.startLatLng.lng }) / 1000
  if (!Number.isFinite(km)) return null
  return km < 3 ? '常跑地点附近' : `离常跑地点约 ${Math.round(km)} km`
}

/**
 * 最近运动记录(手表同步):最近 5 条 + 各类型最近一次补盲区 + 「距上次跑步 N 天」
 * (渲染逻辑迁自 chat.ts,工具迁自 tools.ts)。
 */
export const activitiesProvider: ContextProvider = {
  key: 'activities',
  priority: 50,
  load: async () => {
    const [recent, latestPerType] = await Promise.all([
      getRecentActivityContext(5),
      getLatestActivityPerType(),
    ])
    const lines = recent.map(activityLine)
    // 「最近 N 条」窗口可能全被单一类型占满(比如连续骑行),把每种类型的最近一次补进来,
    // 并显式给出"距上次跑步 N 天"——运动伙伴最关键的事实,不能让模型自己推。
    const lastRun = latestPerType.find(act => act.type === 'running')
    if (lastRun) lines.unshift(`- 距上次跑步已 ${lastRun.daysAgo} 天`)
    const extraPerType = latestPerType.filter(
      act => !recent.some(item => item.date === act.date && item.type === act.type),
    )
    if (extraPerType.length) lines.push('（更早的,各类型最近一次）', ...extraPerType.map(activityLine))

    return {
      key: 'activities',
      title: '# 最近运动记录（手表同步，可直接引用；更早的、按类型找、复盘某天、看趋势 → query_activities）',
      lines: lines.length ? lines : ['- 暂无同步记录（可用 query_activities 再确认）'],
      data: { recentActivityCount: recent.length, lastRunDaysAgo: lastRun?.daysAgo ?? null },
    }
  },
  tools: [
    {
      name: 'query_activities',
      description:
        '查用户的真实运动记录(手表同步),返回含当次实测天气、爬升、起点相对位置(有轨迹/回填才有)。上下文里只有最近几条快照;当用户问"上次跑步/更早的记录/某段时间跑了什么"、复盘具体某一天的活动(传 date),或最近几条都是别的运动类型时,用它。返回按时间倒序。',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['running', 'cycling', 'walking'],
            description: '运动类型过滤;省略则返回所有类型',
          },
          before: {
            type: 'string',
            description: 'YYYY-MM-DD,只看这一天之前的记录(用返回结果里最早的 date 继续往前翻页)',
          },
          date: {
            type: 'string',
            description: 'YYYY-MM-DD,只看这一天的活动——复盘某天的运动就传它(返回带那次的实测天气/爬升)',
          },
          limit: { type: 'number', description: '返回条数,默认 5,最多 20' },
        },
      },
    },
  ],
  executeTool: async (_name, rawInput) => {
    const input = (rawInput ?? {}) as Record<string, unknown>
    const rows = await queryActivityContext({
      type: typeof input.type === 'string' ? input.type : undefined,
      before: typeof input.before === 'string' ? input.before : undefined,
      date: typeof input.date === 'string' ? input.date : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
    })
    // 常跑地点整次调用只解析一次(有 TTL 缓存,但没必要每行都 await)
    const home = await getHomeLocation().catch(() => null)
    return JSON.stringify({
      count: rows.length,
      note: rows.length === 0 ? '没有匹配的记录(库里确实没有,可如实告知)' : undefined,
      activities: rows.map(row => ({
        date: row.date,
        daysAgo: row.daysAgo,
        type: row.type,
        distanceKm: row.distanceKm,
        durationMin: row.durationMin,
        pace: row.paceText ? `${row.paceText}/km` : null,
        avgHeartRate: row.avgHeartRate,
        elevationGainM: row.elevationGainM ?? null,
        weather: row.weather
          ? `${row.weather.temperature}°C${row.weather.description ? ` ${row.weather.description}` : ''}(当次实测)`
          : null,
        startPlace: startPlaceLabel(row, home),
      })),
    })
  },
}
