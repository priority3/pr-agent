import { useEffect, useState } from 'react'
import { MessageSquareText, RefreshCw, Send } from 'lucide-react'

import { cn, formatDateTime } from '../../lib/utils'
import { useToast } from '../../components/ui/toast'

import { LoadingState } from '../../components/shared'

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

export function PrReviewsPanel() {
  const { success, error: toastError } = useToast()
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const fetchReviews = async () => {
    setLoading(true)
    try {
      // P3a 已把 reviews 端点从 /api/activities/reviews 重命名迁入 /api/pr/reviews。
      const res = await fetch('/api/pr/reviews?limit=20', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setReviews(data.reviews ?? [])
        setLoadError(null)
      } else {
        setLoadError(`加载反思失败 (HTTP ${res.status})`)
      }
    } catch (e) {
      setLoadError(`加载反思失败: ${e instanceof Error ? e.message : '网络错误'}`)
    }
    setLoading(false)
  }

  useEffect(() => {
    void Promise.resolve().then(fetchReviews)
  }, [])

  async function resend(id: string) {
    setBusyId(id)
    try {
      const res = await fetch('/api/pr/reviews/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewId: id, dispatchNow: true }),
      })
      if (res.ok) success('已重新发送到微信')
      else toastError(`重发失败 (HTTP ${res.status})`)
    } catch (e) {
      toastError(`重发失败: ${e instanceof Error ? e.message : '网络错误'}`)
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
        <button type="button" onClick={fetchReviews}
          className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10">
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </div>

      {loadError && <p className="text-sm text-rose-400">{loadError}</p>}

      {reviews.length ? (
        <div className="space-y-2">
          {reviews.map(review => (
            <div key={review.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs">
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
                <button type="button" disabled={busyId === review.id} onClick={() => resend(review.id)}
                  className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10 disabled:opacity-50">
                  <Send className="h-3 w-3" /> 重发微信
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
          暂无反思。每天健康数据上报后 PR 会写一条晨间反思。
        </p>
      )}
    </div>
  )
}
