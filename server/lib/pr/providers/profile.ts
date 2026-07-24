import { buildCompanionProfileContext } from '../context'

import type { ContextProvider } from './types'

/** 伙伴画像投影(迁自 chat.ts profileBlock 渲染)。data = CompanionProfileContext,供 evalCtx 取 doNotAssume 等。 */
export const profileProvider: ContextProvider = {
  key: 'profile',
  priority: 20,
  load: async () => {
    const profile = await buildCompanionProfileContext()
    return {
      key: 'profile',
      title: '# 伙伴画像',
      lines: [
        `- 称呼：${profile.displayName ?? '-'}`,
        `- 陪伴风格：${profile.companionStyle.join('；') || '-'}`,
        `- 训练偏好/风险：${profile.trainingPreferences.join('；') || '-'}`,
        `- 伤痛观察：${profile.injuryWatchlist.join('；') || '-'}`,
        `- 不应再默认（务必避开）：${profile.doNotAssume.join('；') || '-'}`,
      ],
      data: profile,
    }
  },
}
