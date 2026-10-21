import { listRelevantContextMemories } from '../memory'

import type { ContextProvider } from './types'

/** 记于哪天(Asia/Shanghai)。记忆里可能出现「下个月」这类相对说法,给它一个可换算的锚点。 */
function memoryDate(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(parsed)
}

/** 长期记忆:按本轮 query 检索相关记忆(迁自 chat.ts build_context)。 */
export const memoryProvider: ContextProvider = {
  key: 'memory',
  priority: 10,
  load: async input => {
    const items = await listRelevantContextMemories(input.message, 6)
    return {
      key: 'memory',
      title: '# 你记得关于他的（长期记忆）',
      // 带上「记于」日期:记忆是长期存的,里面的「下个月/明天」只有配上写入日期才能换算
      // (线上事故:9 月 9 日记的「下个月18号」在 10-20 被按今天算成了 11 月 18 日)。
      lines: items.length
        ? items.map(item => {
          const date = memoryDate(item.createdAt)
          return date ? `- ${item.content}（记于 ${date}）` : `- ${item.content}`
        })
        : ['- 暂无'],
      data: items,
    }
  },
}
