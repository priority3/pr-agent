import { useCallback, useEffect, useState } from 'react'

import Checklist from './Checklist'
import { AuthError, fetchRecord } from './data'
import { duration, fullDayLabel, km, pace } from './format'
import { useIsDark } from './hooks'
import MarkdownText from './MarkdownText'
import PageShell, { PageError, PageSkeleton } from './PageShell'
import { navigate } from './router'
import { splitChecklist } from './tasklist'
import type { ActivityDetail } from './types'

type State =
  | { kind: 'loading' }
  | { kind: 'auth' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ActivityDetail }

/**
 * 单条活动详情。
 *
 * 次序:数字 → 分段表 → PR 点评。
 * 表格回答「发生了什么」,点评回答「所以呢」——所以点评分在表格下面:它是内容的结论,
 * 不是页面的头图。点评正文照旧走 splitChecklist,和对话页同一套切分与勾选(勾选状态共用
 * 同一个 localStorage 键,所以在详情页勾的和在对话里勾的是同一件事)。
 */
export default function RecordDetailPage({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const data = await fetchRecord(id)
      setState({ kind: 'ready', data })
    } catch (error) {
      if (error instanceof AuthError) setState({ kind: 'auth' })
      else setState({ kind: 'error', message: error instanceof Error ? error.message : '加载失败' })
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <PageShell
      title={state.kind === 'ready' ? state.data.activity.title : '训练详情'}
      subtitle={state.kind === 'ready' ? `${fullDayLabel(state.data.activity.startTime)} · ${duration(state.data.activity.duration)}` : undefined}
      onBack={() => navigate('#/records')}
    >
      {state.kind === 'loading' && <PageSkeleton />}
      {state.kind === 'auth' && <PageError message="访问已失效，请用新的链接重新进入。" />}
      {state.kind === 'error' && <PageError message={`没拉到这条记录：${state.message}`} onRetry={() => void load()} />}
      {state.kind === 'ready' && <Ready data={state.data} />}
    </PageShell>
  )
}

function Ready({ data }: { data: ActivityDetail }) {
  const { activity, splits, review } = data
  const isDark = useIsDark()

  return (
    <div>
      <div className="flex items-baseline gap-6">
        <Kpi value={km(activity.distance)} label="公里" />
        <Kpi value={pace(activity.averagePace)} label="平均配速" />
        <Kpi value={activity.averageHeartRate ? String(activity.averageHeartRate) : '—'} label="平均心率" />
      </div>

      {splits.length > 0 && (
        <>
          <div className="pr-caption">分段</div>
          <table className="pr-table">
            <thead>
              <tr>
                <th>公里</th>
                <th className="is-num">配速</th>
                <th className="is-num">心率</th>
              </tr>
            </thead>
            <tbody>
              {splits.map(s => (
                <tr key={s.kilometer}>
                  <td className="pr-num">{s.kilometer}</td>
                  <td className="is-num">{pace(s.pace)}</td>
                  <td className="is-num">{s.averageHeartRate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {review ? (
        <div className="mt-7" style={{ borderTop: '1px solid var(--pr-line)', paddingTop: 14 }}>
          <div className="pr-meta text-[11px]" style={{ color: 'var(--pr-muted)' }}>
            PR · {fullDayLabel(review.createdAt)}
          </div>
          <div className="pr-markdown mt-1.5 text-[14px] leading-[1.78]">
            {splitChecklist(review.content).map((seg, i) =>
              seg.kind === 'md' ? (
                <MarkdownText key={i} messageId={`review-${activity.id}-${i}`} isDark={isDark}>
                  {seg.text}
                </MarkdownText>
              ) : (
                <Checklist key={i} items={seg.items} />
              ),
            )}
          </div>
        </div>
      ) : (
        <div className="mt-7 text-[13px] leading-[1.7]" style={{ borderTop: '1px solid var(--pr-line)', paddingTop: 14, color: 'var(--pr-text-2)' }}>
          这次还没有 PR 点评。跑完的复盘会在同步完成后自动生成；想现在就问，直接去对话里说这次的感觉。
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          className="pr-btn"
          onClick={() => {
            // 预填一句带上下文的开场,用户可改可删;真正发出去仍然要他自己点发送
            try {
              localStorage.setItem('pr_chat_draft', `聊聊这次：${activity.title}（${km(activity.distance)} 公里，配速 ${pace(activity.averagePace)}）`)
            } catch {
              // 隐私模式写不进去就只跳转,不阻断
            }
            navigate('#/')
          }}
        >
          和 PR 聊聊这次
        </button>
        <span className="pr-meta text-[11px]" style={{ color: 'var(--pr-muted)' }}>
          {activity.source}
        </span>
      </div>
    </div>
  )
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="pr-num text-[24px] font-medium leading-none tracking-tight">{value}</div>
      <div className="mt-1.5 text-[11px]" style={{ color: 'var(--pr-text-2)' }}>
        {label}
      </div>
    </div>
  )
}
