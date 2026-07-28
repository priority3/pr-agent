import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, Brain, Check, Pencil, X } from 'lucide-react'

import { failureMessage, isUnauthorized, jsonBody } from '../../lib/api'
import { cn, formatDateTime } from '../../lib/utils'
import { useToast } from '../../components/ui/toast'
import { ErrorState, LoadingState, RefreshButton } from '../../components/shared'
import { useApi } from '../session'

import { ArchivedMemories } from './ArchivedMemories'
import { TYPE_LABEL, TYPE_OPTIONS, typeClass, type MemoryItem } from './memory-types'

export function MemoryPanel() {
  const api = useApi()
  const { success, error: toastError } = useToast()
  const [memories, setMemories] = useState<MemoryItem[]>([])
  // loading = 首屏(还没有任何内容可显示);refreshing = 手动刷新/写操作后重拉,
  // 此时保留旧列表只让刷新图标转,避免整块内容消失导致的高度跳变(E1)。
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editType, setEditType] = useState('preference')
  // 两段式归档:第一下把按钮变成「确认归档」,3 秒不点自动还原(与 H5 删会话同款)。
  const [armedId, setArmedId] = useState<string | null>(null)
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 归档/恢复后让「已归档」折叠区跟着刷新。
  const [archiveToken, setArchiveToken] = useState(0)

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'refresh') => {
      if (mode === 'refresh') setRefreshing(true)
      try {
        const data = await api.json<{ memories?: MemoryItem[] }>('/api/pr/memories?status=candidate,active')
        setMemories(data.memories ?? [])
        setLoadError(null)
      } catch (error) {
        // 401 由会话层统一切回登录门,这里不再渲染红字(S12)。
        if (!isUnauthorized(error)) setLoadError(failureMessage('加载记忆', error))
      }
      setLoading(false)
      setRefreshing(false)
    },
    [api],
  )

  useEffect(() => {
    void Promise.resolve().then(() => load('initial'))
  }, [load])

  useEffect(() => () => clearArmTimer(), [])

  function clearArmTimer() {
    if (armTimerRef.current) clearTimeout(armTimerRef.current)
    armTimerRef.current = null
  }

  function armArchive(id: string) {
    clearArmTimer()
    setArmedId(id)
    armTimerRef.current = setTimeout(() => setArmedId(null), 3000)
  }

  async function act(id: string, path: 'confirm' | 'archive', label: string) {
    clearArmTimer()
    setArmedId(null)
    setBusyId(id)
    try {
      await api.request(`/api/pr/memories/${id}/${path}`, { method: 'POST' })
      success(`已${label}`)
      if (path === 'archive') setArchiveToken(t => t + 1)
      await load('refresh')
    } catch (error) {
      if (!isUnauthorized(error)) toastError(failureMessage(label, error))
    }
    setBusyId(null)
  }

  function startEdit(memory: MemoryItem) {
    setEditing(memory.id)
    setEditContent(memory.content)
    setEditType(memory.type)
  }

  async function saveEdit(id: string) {
    // 空内容按钮已 disabled(E8),这里只是最后一道防线。
    if (!editContent.trim()) return
    setBusyId(id)
    try {
      await api.request(
        `/api/pr/memories/${id}`,
        jsonBody('PATCH', { content: editContent.trim(), type: editType, reason: '用户在面板编辑记忆。' }),
      )
      success('已保存')
      setEditing(null)
      await load('refresh')
    } catch (error) {
      if (!isUnauthorized(error)) toastError(failureMessage('保存', error))
    }
    setBusyId(null)
  }

  const candidates = memories.filter(m => m.status === 'candidate')
  const actives = memories.filter(m => m.status === 'active')
  // 出错且没有可显示的旧数据时,只给「失败 + 重试」,不再并排显示空态(E2)。
  const showList = !loadError || memories.length > 0

  function renderRow(memory: MemoryItem) {
    const isEditing = editing === memory.id
    const busy = busyId === memory.id
    const armed = armedId === memory.id
    const canSave = editContent.trim().length > 0
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
                {!canSave && <p className="text-xs text-amber-300/80">内容不能为空，删掉整条请用「归档」。</p>}
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {isEditing ? (
            <>
              <button type="button" disabled={busy || !canSave} onClick={() => void saveEdit(memory.id)}
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
                <button type="button" disabled={busy} onClick={() => void act(memory.id, 'confirm', '确认')}
                  className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50">
                  <Check className="h-3 w-3" /> 确认
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => startEdit(memory)}
                className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50">
                <Pencil className="h-3 w-3" /> 编辑
              </button>
              {armed ? (
                <>
                  <button type="button" disabled={busy} onClick={() => void act(memory.id, 'archive', '归档')}
                    className="inline-flex items-center gap-1 rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30 disabled:opacity-50">
                    <Archive className="h-3 w-3" /> 确认归档？
                  </button>
                  <button type="button" onClick={() => { clearArmTimer(); setArmedId(null) }}
                    className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10">
                    <X className="h-3 w-3" /> 取消
                  </button>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => armArchive(memory.id)}
                  className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/50 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50">
                  <Archive className="h-3 w-3" /> 归档
                </button>
              )}
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
        <RefreshButton busy={refreshing} onClick={() => void load('refresh')} />
      </div>

      {loadError && <ErrorState message={loadError} onRetry={() => void load('refresh')} retrying={refreshing} />}

      {showList && (
        <div className={cn('space-y-4 transition-opacity', refreshing && 'opacity-60')}>
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-white/40">
              待确认候选（{candidates.length}）· 确认后才会影响 PR 对你的判断
            </p>
            {candidates.length ? (
              <div className="space-y-2">{candidates.map(renderRow)}</div>
            ) : (
              !loadError && (
                <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
                  暂无候选记忆。等你和 PR 聊天或反馈时，它会蒸馏出候选放这里。
                </p>
              )
            )}
          </div>

          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-white/40">已生效（{actives.length}）</p>
            {actives.length ? (
              <div className="space-y-2">{actives.map(renderRow)}</div>
            ) : (
              !loadError && (
                <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
                  还没有生效记忆。确认候选或多次证据累积后会出现在这里。
                </p>
              )
            )}
          </div>
        </div>
      )}

      <ArchivedMemories refreshToken={archiveToken} onRestored={() => void load('refresh')} />
    </div>
  )
}
