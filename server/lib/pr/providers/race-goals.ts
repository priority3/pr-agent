import { getRaceGoalContext, raceGoalSummary } from '../race-goals'
import { listRacePlans } from '../race-plans'
import { raceResearchLines, researchRacePlan } from '../race-research'
import { z } from 'zod'

import type { ContextProvider } from './types'

/** 比赛目标(迁自 chat.ts goalLines)。data.goalLines 供回复落库/快照复用。 */
export const raceGoalsProvider: ContextProvider = {
  key: 'goals',
  priority: 60,
  load: async () => {
    const [goals, plans] = await Promise.all([getRaceGoalContext(20), listRacePlans()])
    const goalLines = goals.map(goal => `${raceGoalSummary(goal)}；日期 ${goal.raceDate}；${goal.distanceMeters / 1000} 公里；目标 ${goal.targetType}${goal.targetTimeSec ? ` ${goal.targetTimeSec} 秒` : ''}；优先级 ${goal.priority}`)
    const planLines = plans.flatMap(plan => [
      `用户赛事计划 ${plan.id}：${plan.name}；${plan.raceDate ?? '日期待确认'}；${plan.city ?? '地点待确认'}；${plan.distanceMeters == null ? '距离待确认' : `${plan.distanceMeters / 1000} 公里`}；${plan.status}`,
      ...plan.evidence.slice(-2).map(evidence => `用户来源 ${evidence.source}，消息 ${evidence.messageId}，发送于 ${evidence.messageCreatedAt}，日期参考 ${evidence.dateReference ?? '未知'}；原话：${JSON.stringify(evidence.quote)}`),
      ...raceResearchLines(plan.research),
    ])
    const upcoming = plans.filter(plan => plan.status === 'active' && plan.raceDate).sort((a, b) => a.raceDate!.localeCompare(b.raceDate!))
    const gaps = upcoming.slice(1).map((plan, index) => `${upcoming[index].name} → ${plan.name} 间隔 ${Math.round((Date.parse(plan.raceDate!) - Date.parse(upcoming[index].raceDate!)) / 86400000)} 天。`)
    return {
      key: 'goals',
      title: '# 比赛目标',
      lines: [...(goalLines.length ? goalLines.map(line => `- ${line}`) : ['- 无正式目标']), ...planLines, ...gaps],
      data: { goalLines, plans },
    }
  },
  tools: [{
    name: 'query_race_details',
    description: '查询已保存的赛事计划及带来源的路线、海拔、累计爬升、坡段、补给和关门时间。无参数列出计划及缓存；planId 查询单场并在缺资料时联网查证，refresh 可重新查询。sourceUrls 可提供用户给出的资料页链接。',
    inputSchema: { type: 'object', properties: {
      planId: { type: 'string' }, refresh: { type: 'boolean' },
      sourceUrls: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    } },
  }],
  executeTool: async (_name, input) => {
    const parsed = z.object({ planId: z.string().optional(), refresh: z.boolean().optional(), sourceUrls: z.array(z.string().url()).max(6).optional() }).safeParse(input)
    if (!parsed.success) return JSON.stringify({ error: '赛事查询参数无效' })
    try {
      if (!parsed.data.planId) return JSON.stringify({ plans: await listRacePlans() })
      return JSON.stringify(await researchRacePlan(parsed.data.planId, { force: parsed.data.refresh, sourceUrls: parsed.data.sourceUrls }))
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message })
    }
  },
}
