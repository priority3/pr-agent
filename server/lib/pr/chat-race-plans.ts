import { projectFriendProfile } from './memory'
import { extractRacePlans, type RaceExtractionInput } from './race-plan-extraction'
import { saveRacePlans } from './race-plans'
import { researchRacePlan } from './race-research'
import type { PrStreamEvent } from './model'

export async function prepareChatRacePlans(input: RaceExtractionInput, runId: string, onStream?: (event: PrStreamEvent) => void) {
  if (!input.images?.length && !/马拉松|半马|全马|比赛|赛事|参赛|越野|\d+\s*[kK]\b/.test(input.message)) return null
  onStream?.({ type: 'tool', name: 'extract_race_plans' })
  try {
    const extracted = await extractRacePlans(input)
    const saved = await saveRacePlans(extracted, runId)
    if (!saved.length) return { title: '# 本轮赛事计划保存结果', lines: ['本轮没有新增赛事计划；不要声称修改了已有比赛目标或完成报名。'] }
    await projectFriendProfile().catch(() => {})
    onStream?.({ type: 'tool', name: 'query_race_details' })
    // 两场一组,限制同时抓取/模型调用数量;多场计划全部保存并逐场查询。
    for (let index = 0; index < saved.length; index += 2) {
      await Promise.allSettled(saved.slice(index, index + 2).filter(plan => plan.status === 'active').map(plan => researchRacePlan(plan.id)))
    }
    return {
      title: '# 本轮赛事计划保存结果',
      lines: saved.map(plan => `${plan.name}：${plan.raceDate ?? '日期待确认'}，${plan.distanceMeters == null ? '距离待确认' : `${plan.distanceMeters / 1000} 公里`}；${plan.status === 'active' ? '已保存参赛计划、正式目标及文字记忆（不代表已报名）' : '仅保存为待确认条目，尚未建立正式目标，请确认日期/组别/参赛意图'}；计划 ID ${plan.id}`),
    }
  } catch (error) {
    console.warn('[pr-chat] 赛事计划提取/保存失败:', (error as Error).message)
    return { title: '# 本轮赛事计划保存结果', lines: ['本轮赛事提取或保存失败，不能声称已记住、已修改目标。用户原始消息已保存，可以重新发送赛事信息重试。'] }
  }
}
