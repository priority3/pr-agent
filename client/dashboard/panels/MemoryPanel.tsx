import { useEffect, useState } from 'react'
import { Brain, Check, Pencil, Archive, RefreshCw, X } from 'lucide-react'

import { cn, formatDateTime } from '../../lib/utils'
import { useToast } from '../../components/ui/toast'

import { LoadingState } from '../../components/shared'

interface MemoryItem {
  id: string
  type: string
  status: string
  content: string
  confidence: number
  evidence: unknown[]
  version: number
  lastSeenAt: string
}

const TYPE_LABEL: Record<string, string> = {
  preference: '偏好',
  habit: '习惯',
  goal: '目标',
  injury: '伤病',
  correction: '纠正',
  risk_pattern: '风险',
  relationship_note: '关系',
}

const TYPE_OPTIONS = Object.keys(TYPE_LABEL)

function typeClass(type: string) {
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

export function MemoryPanel() {
  const { success, error: toastError } = useToast()
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editType, setEditType] = useState('preference')

  const fetchMemories = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/pr/memories?status=candidate,active', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setMemories(data.memories ?? [])
        setLoadError(null)
      } else {
        setLoadError(`加载记忆失败 (HTTP ${res.status})`)
      }
    } catch (e) {
      setLoadError(`加载记忆失败: ${e instanceof Error ? e.message : '网络错误'}`)
    }
    setLoading(false)
  }

  useEffect(() => {
    void Promise.resolve().then(fetchMemories)
  }, [])

  async function act(id: string, path: string, label: string) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/pr/memories/${id}/${path}`, { method: 'POST' })
      if (res.ok) {
        success(`已${label}`)
        await fetchMemories()
      } else {
        toastError(`${label}失败 (HTTP ${res.status})`)
      }
    } catch (e) {
      toastError(`${label}失败: ${e instanceof Error ? e.message : '网络错误'}`)
    }
    setBusyId(null)
  }

  function startEdit(memory: MemoryItem) {
    setEditing(memory.id)
    setEditContent(memory.content)
    setEditType(memory.type)
  }

  async function saveEdit(id: string) {
    if (!editContent.trim()) return
    setBusyId(id)
    try {
      const res = await fetch(`/api/pr/memories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent.trim(), type: editType, reason: '用户在面板编辑记忆。' }),
      })
      if (res.ok) {
        success('已保存')
        setEditing(null)
        await fetchMemories()
      } else {
        toastError(`保存失败 (HTTP ${res.status})`)
      }
    } catch (e) {
      toastError(`保存失败: ${e instanceof Error ? e.message : '网络错误'}`)
    }
    setBusyId(null)
  }

  const candidates = memories.filter(m => m.status === 'candidate')
  const actives = memories.filter(m => m.status === 'active')

  function renderRow(memory: MemoryItem) {
    const isEditing = editing === memory.id
    const busy = busyId === memory.id
    return (
      <div key={memory.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-start gap-2">
          <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-xs', typeClass(memory.type))}>
            {TYPE_LABEL[memory.type] ?? memory.type}
          </span>
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  rows={2}
                  className="w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
                />
                <select
                  value={editType}
                  onChange={e => setEditType(e.target.value)}
                  className="rounded border border-white/15 bg-black/30 px-2 py-1 text-xs text-white"
                >
                  {TYPE_OPTIONS.map(t => (
                    <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="break-words text-sm text-white/90">{memory.content}</p>
            )}
            <p className="mt-1 text-xs text-white/40">
              置信 {memory.confidence.toFixed(2)} · 证据 {memory.evidence?.length ?? 0} · {formatDateTime(memory.lastSeenAt)}
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {isEditing ? (
            <>
              <button type="button" disabled={busy} onClick={() => saveEdit(memory.id)}
                className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50">
                <Check className="h-3 w-3" /> 保存
              </button>
              <button type="button" onClick={() => setEditing(null)}
                className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10">
                <X className="h-3 w-3" /> 取消
              </button>
            </>
          ) : (
            <>
              {memory.status === 'candidate' && (
                <button type="button" disabled={busy} onClick={() => act(memory.id, 'confirm', '确认')}
                  className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50">
                  <Check className="h-3 w-3" /> 确认
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => startEdit(memory)}
                className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50">
                <Pencil className="h-3 w-3" /> 编辑
              </button>
              <button type="button" disabled={busy} onClick={() => act(memory.id, 'archive', '归档/纠正')}
                className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/50 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50">
                <Archive className="h-3 w-3" /> 归档
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  if (loading) return <LoadingState />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-white/80">
          <Brain className="h-4 w-4" /> PR 的记忆
        </h3>
        <button type="button" onClick={fetchMemories}
          className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10">
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </div>

      {loadError && <p className="text-sm text-rose-400">{loadError}</p>}

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-white/40">
          待确认候选（{candidates.length}）· 确认后才会影响 PR 对你的判断
        </p>
        {candidates.length ? (
          <div className="space-y-2">{candidates.map(renderRow)}</div>
        ) : (
          <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
            暂无候选记忆。等你和 PR 聊天或反馈时，它会蒸馏出候选放这里。
          </p>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-white/40">已生效（{actives.length}）</p>
        {actives.length ? (
          <div className="space-y-2">{actives.map(renderRow)}</div>
        ) : (
          <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
            还没有生效记忆。确认候选或多次证据累积后会出现在这里。
          </p>
        )}
      </div>
    </div>
  )
}
