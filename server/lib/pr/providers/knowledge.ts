import { retrieveKnowledge } from '../rag'

import type { ContextProvider } from './types'

/** 训练知识库 RAG 命中(迁自 chat.ts build_context;每条截 220 字)。 */
export const knowledgeProvider: ContextProvider = {
  key: 'knowledge',
  priority: 30,
  load: async input => {
    const items = await retrieveKnowledge(input.message, 3)
    return {
      key: 'knowledge',
      title: '# 训练知识库命中',
      lines: items.length ? items.map(item => `- ${item.content.slice(0, 220)}`) : ['- 无命中'],
      data: items,
    }
  },
}
