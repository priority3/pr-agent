import { getLatestHealthDailyMetrics } from '../health'

import type { ContextProvider } from './types'

/**
 * 最近身体数据:快照只带最新一天;趋势/前几天走自带的 query_health_daily 工具
 * (快照渲染迁自 chat.ts healthLine,工具迁自 tools.ts)。
 */
export const healthProvider: ContextProvider = {
  key: 'health',
  priority: 40,
  load: async () => {
    const [latest] = await getLatestHealthDailyMetrics(1)
    return {
      key: 'health',
      title: '# 最近身体数据',
      lines: latest
        ? [
            `- ${latest.date}：睡 ${latest.sleepMinutes ?? '-'} 分、静息心率 ${latest.restingHr ?? '-'}、HRV ${latest.hrv ?? '-'}、步数 ${latest.steps ?? '-'}、恢复 ${latest.recoveryLabel}`,
          ]
        : ['- 暂无'],
      data: { hasHealth: Boolean(latest) },
    }
  },
  tools: [
    {
      name: 'query_health_daily',
      description:
        '查最近 N 天的每日健康/恢复数据(睡眠、HRV、静息心率、步数、恢复评级)。上下文默认只带最新一天;用户问睡眠/恢复趋势或前几天的情况时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '最近几天,默认 7,最多 30' },
        },
      },
    },
  ],
  executeTool: async (_name, rawInput) => {
    const input = (rawInput ?? {}) as Record<string, unknown>
    const days = Math.min(Math.max(Math.trunc(typeof input.days === 'number' ? input.days : 7), 1), 30)
    const rows = await getLatestHealthDailyMetrics(days)
    return JSON.stringify({
      count: rows.length,
      days: rows.map(row => ({
        date: row.date,
        sleepMinutes: row.sleepMinutes,
        hrv: row.hrv,
        restingHr: row.restingHr,
        steps: row.steps,
        recovery: row.recoveryLabel,
      })),
    })
  },
}
