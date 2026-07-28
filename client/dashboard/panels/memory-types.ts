// 记忆面板共用的类型与展示映射(MemoryPanel 与 ArchivedMemories 都要用,
// 单独成文件避免两个组件互相 import 成环)。

export interface MemoryItem {
  id: string
  type: string
  status: string
  content: string
  confidence: number
  evidence: unknown[]
  version: number
  lastSeenAt: string
}

export const TYPE_LABEL: Record<string, string> = {
  preference: '偏好',
  habit: '习惯',
  goal: '目标',
  injury: '伤病',
  correction: '纠正',
  risk_pattern: '风险',
  relationship_note: '关系',
}

export const TYPE_OPTIONS = Object.keys(TYPE_LABEL)

export function typeClass(type: string) {
  switch (type) {
    case 'correction':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30'
    case 'injury':
    case 'risk_pattern':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    case 'goal':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30'
    default:
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  }
}
