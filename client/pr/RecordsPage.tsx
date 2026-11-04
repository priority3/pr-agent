import { useCallback, useEffect, useState } from 'react'

import { AuthError, fetchRecords } from './data'
import { dayLabel, groupByWeek, km, rowSub, typeMark } from './format'
import { GearIcon } from './icons'
import PageShell, { PageEmpty, PageError, PageSkeleton } from './PageShell'
import { navigate } from './router'
import type { RecordItem, WeekSummary } from './types'

type State =
  | { kind: 'loading' }
  | { kind: 'auth' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; week: WeekSummary; activities: RecordItem[] }

/**
 * 训练记录页。
 *
 * 结构次序是有意的:数字 → 柱图 → 列表。
 * 「这周跑了多少」是一句话就能答的问题,先给数字;柱图只是把它摊开到七天;
 * 列表才是逐条的明细。反过来(先列表再汇总)用户得自己加总,那是报表不是伙伴。
 *
 * 一处彩色:柱图里「今天」那根。其余全是墨色。
 */
export default function RecordsPage() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const data = await fetchRecords()
      setState({ kind: 'ready', week: data.week, activities: data.activities })
    } catch (error) {
      if (error instanceof AuthError) setState({ kind: 'auth' })
      else setState({ kind: 'error', message: error instanceof Error ? error.message : '加载失败' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <PageShell
      title="训练记录"
      onBack={() => navigate('#/')}
      right={
        <button
          type="button"
          onClick={() => navigate('#/settings')}
          className="pr-tap rounded-lg p-1.5"
          style={{ color: 'var(--pr-text-2)' }}
          aria-label="设置"
        >
          <GearIcon />
        </button>
      }
    >
      {state.kind === 'loading' && <PageSkeleton />}
      {state.kind === 'auth' && <PageError message="访问已失效，请用新的链接重新进入。" />}
      {state.kind === 'error' && <PageError message={`没拉到记录：${state.message}`} onRetry={() => void load()} />}
      {state.kind === 'ready' && (
        <Ready week={state.week} activities={state.activities} onReload={() => void load()} />
      )}
    </PageShell>
  )
}

function Ready({ week, activities, onReload }: { week: WeekSummary; activities: RecordItem[]; onReload: () => void }) {
  if (activities.length === 0) {
    return (
      <PageEmpty
        title="还没有训练记录"
        hint="数据同步进来或手动导入之后，这里会按周排开，不只列条目，也告诉你这周和上周差多少。"
        action={
          <button type="button" onClick={onReload} className="pr-btn">
            重新检查
          </button>
        }
      />
    )
  }

  const max = Math.max(...week.days, 1)
  // 今天是这一周的第七天之前才有「今天」这根柱
  const todayIndex = (new Date().getDay() + 6) % 7

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="pr-num text-[30px] font-medium leading-none tracking-tight">{km(week.distance)}</span>
        <span className="text-[13px]" style={{ color: 'var(--pr-text-2)' }}>
          公里 · 本周 {week.count} 次
        </span>
      </div>

      <div className="pr-bars" aria-hidden="true">
        {week.days.map((meters, i) => (
          <span key={i} className="pr-bar-col">
            <i
              className={i === todayIndex ? 'on' : undefined}
              style={{ height: `${Math.max((meters / max) * 100, 4)}%` }}
            />
          </span>
        ))}
      </div>
      <div className="pr-bars-x pr-num">
        {['一', '二', '三', '四', '五', '六', '日'].map((d, i) => (
          <span key={d} style={{ color: i === todayIndex ? 'var(--pr-text)' : undefined }}>
            {d}
          </span>
        ))}
      </div>

      {groupByWeek(activities, week.start).map(group => (
        <div key={group.label}>
          <div className="pr-grp">{group.label}</div>
          {group.items.map(item => (
            <button
              key={item.id}
              type="button"
              className="pr-lrow"
              onClick={() => navigate(`#/records/${encodeURIComponent(item.id)}`)}
            >
              <span className="pr-mark">{typeMark(item.type)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]" style={{ color: 'var(--pr-text)' }}>
                  {item.title}
                  {item.reviewed && (
                    <span className="pr-dot-solid ml-1.5 align-middle" style={{ background: 'var(--pr-accent)' }} />
                  )}
                </span>
                <span className="pr-num mt-0.5 block truncate text-[12px]" style={{ color: 'var(--pr-text-2)' }}>
                  {km(item.distance)} 公里 · {rowSub(item)}
                </span>
              </span>
              <span className="pr-meta shrink-0 text-[11px]" style={{ color: 'var(--pr-muted)' }}>
                {dayLabel(item.startTime)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
