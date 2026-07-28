/**
 * 已归档记忆(S14):归档过去是不可逆的黑洞——列表写死 status=candidate,active,
 * 归档后条目从 UI 彻底消失。后端 GET /api/pr/memories?status=archived 一直支持,
 * 这里补上入口:折叠区按需拉取,并用 PATCH { status: 'candidate' } 提供恢复
 * (恢复成候选而非直接生效,须再确认一次,与「确认后才影响判断」的语义一致)。
 */
import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestore, ChevronDown, RotateCcw } from 'lucide-react'

import { failureMessage, isUnauthorized, jsonBody } from '../../lib/api'
import { cn, formatDateTime } from '../../lib/utils'
import { useToast } from '../../components/ui/toast'
import { ErrorState } from '../../components/shared'
import { useApi } from '../session'

import { TYPE_LABEL, typeClass, type MemoryItem } from './memory-types'

export function ArchivedMemories({ refreshToken, onRestored }: { refreshToken: number; onRestored: () => void }) {
  const api = useApi()
  const { success, error: toastError } = useToast()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.json<{ memories?: MemoryItem[] }>('/api/pr/memories?status=archived')
      setItems(data.memories ?? [])
      setLoadError(null)
    } catch (error) {
      if (!isUnauthorized(error)) setLoadError(failureMessage('加载已归档记忆', error))
    }
    setLoading(false)
  }, [api])

  // 展开时拉一次;之后父层归档/恢复完 bump refreshToken 让这里跟着刷新(收起时不请求)。
  useEffect(() => {
    if (!open) return
    void Promise.resolve().then(load)
  }, [open, refreshToken, load])

  async function restore(id: string) {
    setBusyId(id)
    try {
      await api.request(
        `/api/pr/memories/${id}`,
        jsonBody('PATCH', { status: 'candidate', reason: '用户在面板恢复已归档记忆。' }),
      )
      success('已恢复为候选，确认后才会重新生效')
      await load()
      onRestored()
    } catch (error) {
      if (!isUnauthorized(error)) toastError(failureMessage('恢复', error))
    }
    setBusyId(null)
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-white/40 transition-colors hover:text-white/70"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
        已归档{open && !loading ? `（${items.length}）` : ''}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {loadError && <ErrorState message={loadError} onRetry={() => void load()} retrying={loading} />}
          {loading && <p className="text-xs text-white/40">加载中…</p>}
          {!loadError && !loading && items.length === 0 && (
            <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
              还没有归档过的记忆。归档掉的错误记忆会留在这里，可以随时恢复。
            </p>
          )}
          {items.map(memory => (
            <div key={memory.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-3 opacity-70">
              <div className="flex items-start gap-2">
                <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-xs', typeClass(memory.type))}>
                  {TYPE_LABEL[memory.type] ?? memory.type}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-white/70 line-through decoration-white/20">{memory.content}</p>
                  <p className="mt-1 text-xs text-white/30">
                    <ArchiveRestore className="mr-1 inline h-3 w-3" />
                    归档于 {formatDateTime(memory.lastSeenAt)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === memory.id}
                onClick={() => void restore(memory.id)}
                className="mt-2 inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" /> 恢复为候选
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
