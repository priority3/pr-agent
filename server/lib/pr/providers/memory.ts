import { listRelevantContextMemories } from '../memory'

import type { ContextProvider } from './types'

/** 长期记忆:按本轮 query 检索相关记忆(迁自 chat.ts build_context)。 */
export const memoryProvider: ContextProvider = {
  key: 'memory',
  priority: 10,
  load: async input => {
    const items = await listRelevantContextMemories(input.message, 6)
    return {
      key: 'memory',
      title: '# 你记得关于他的（长期记忆）',
      lines: items.length ? items.map(item => `- ${item.content}`) : ['- 暂无'],
      data: items,
    }
  },
}
