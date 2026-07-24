import { getRaceGoalContext, raceGoalSummary } from '../race-goals'

import type { ContextProvider } from './types'

/** 比赛目标(迁自 chat.ts goalLines)。data.goalLines 供回复落库/快照复用。 */
export const raceGoalsProvider: ContextProvider = {
  key: 'goals',
  priority: 60,
  load: async () => {
    const goals = await getRaceGoalContext(3)
    const goalLines = goals.map(raceGoalSummary)
    return {
      key: 'goals',
      title: '# 比赛目标',
      lines: goalLines.length ? goalLines.map(line => `- ${line}`) : ['- 无'],
      data: { goalLines },
    }
  },
}
