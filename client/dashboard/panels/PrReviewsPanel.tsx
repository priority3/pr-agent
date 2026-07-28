import { useCallback, useEffect, useState } from 'react'
import { MessageSquareText, Send } from 'lucide-react'

import { failureMessage, isUnauthorized, jsonBody } from '../../lib/api'
import { cn, formatDateTime } from '../../lib/utils'
import { useToast } from '../../components/ui/toast'
import { ErrorState, LoadingState, RefreshButton } from '../../components/shared'
import { useApi } from '../session'

interface ReviewSummary {
  id: string
  kind: string
  subjectId: string
  activityId: string | null
  content: string
  model: string
  provider: string | null
  createdAt: string
}

const KIND_LABEL: Record<string, string> = {
  pr_recovery_review: '晨间反思',
  pr_activity_review: '跑后复盘',
  pr_weekly_review: '周总结',
}

// '' = 不带 kind 参数(全部)。后端 GET /api/pr/reviews 支持 ?kind=(逗号分隔)。
const KIND_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
]

export function PrReviewsPanel() {
  const api = useApi()
  const { success, error: toastError } = useToast()
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  const [kind, setKind] = useState('')
  // 首屏 spinner 只出现一次;之后切筛选/刷新保留旧列表(E1)。
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      // P3a 已把 reviews 端点从 /api/activities/reviews 重命名迁入 /api/pr/reviews。
      const query = kind ? `?limit=20&kind=${encodeURIComponent(kind)}` : '?limit=20'
      const data = await api.json<{ reviews?: ReviewSummary[] }>(`/api/pr/reviews${query}`)
      setReviews(data.reviews ?? [])
      setLoadError(null)
    } catch (error) {
      if (!isUnauthorized(error)) setLoadError(failureMessage('加载反思', error))
    }
    setLoading(false)
    setRefreshing(false)
  }, [api, kind])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  async function resend(id: string) {
    setBusyId(id)
    try {
      await api.request('/api/pr/reviews/notify', jsonBody('POST', { reviewId: id, dispatchNow: true }))
      success('已重新发送通知')
    } catch (error) {
      if (!isUnauthorized(error)) toastError(failureMessage('重发', error))
    }
    setBusyId(null)
  }

  if (loading) return <LoadingState />

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-white/80">
          <MessageSquareText className="h-4 w-4" /> PR 最近的话
        </h3>
        <RefreshButton busy={refreshing} onClick={() => void load()} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {KIND_FILTERS.map(filter => (
          <button
            key={filter.value || 'all'}
            type="button"
            onClick={() => setKind(filter.value)}
            className={cn(
              'rounded border px-2 py-0.5 text-xs transition-colors',
              kind === filter.value
                ? 'border-white/30 bg-white/15 text-white/90'
                : 'border-white/10 bg-white/[0.03] text-white/50 hover:bg-white/10',
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loadError && <ErrorState message={loadError} onRetry={() => void load()} retrying={refreshing} />}

      {reviews.length ? (
        <div className={cn('space-y-2 transition-opacity', refreshing && 'opacity-60')}>
          {reviews.map(review => (
            <div key={review.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-white/70">
                  {KIND_LABEL[review.kind] ?? review.kind}
                </span>
                <span className="text-white/50">{review.subjectId}</span>
                <span className={cn('text-white/40', review.provider === 'local-rule' && 'text-amber-400/70')}>
                  {review.provider === 'local-rule' ? '规则兜底' : review.model}
                </span>
                <span className="ml-auto text-white/30">{formatDateTime(review.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/85">{review.content}</p>
              <div className="mt-2">
                <button type="button" disabled={busyId === review.id} onClick={() => void resend(review.id)}
                  className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10 disabled:opacity-50">
                  <Send className="h-3 w-3" /> 重发通知
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        // 出错时不再和红字并排显示「暂无反思」(E2)——那会让人不知道该重试还是等数据。
        !loadError && (
          <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
            {kind
              ? `暂无「${KIND_LABEL[kind]}」。换个类型或稍后再看。`
              : '暂无反思。每天健康数据上报后 PR 会写一条晨间反思。'}
          </p>
        )
      )}
    </div>
  )
}
