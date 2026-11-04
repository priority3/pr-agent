import { useCallback, useEffect, useState } from 'react'

import { AuthError, clearThreads, downloadCsv, fetchAccount } from './data'
import { dayLabel, fullDayLabel } from './format'
import PageShell, { PageError, PageSkeleton } from './PageShell'
import { navigate } from './router'
import type { AccountInfo } from './types'

type State =
  | { kind: 'loading' }
  | { kind: 'auth' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AccountInfo }

/**
 * 设置页 = 「访问与数据」。
 *
 * 刻意没有「每周汇总推送」「跑后主动点评」这类开关:背后没有任何定时任务读它们,
 * 开关一动只是让用户以为设置生效了 —— 那是假控件(skill 里的判据:答不出「这个世界
 * 是什么」的东西,放上去就是贴上去的)。这一页只放真实存在、真的能改的东西:
 * 能导出、能清空、能看到令牌何时失效。
 */
export default function SettingsPage() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const data = await fetchAccount()
      setState({ kind: 'ready', data })
    } catch (error) {
      if (error instanceof AuthError) setState({ kind: 'auth' })
      else setState({ kind: 'error', message: error instanceof Error ? error.message : '加载失败' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onExport() {
    setBusy(true)
    try {
      await downloadCsv()
      setNotice('已开始下载')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  async function onClearThreads() {
    // 二次确认:这是不可恢复的操作,不做「点了就删」
    if (!window.confirm('清空全部对话？消息不可恢复（训练记录不受影响）。')) return
    setBusy(true)
    try {
      const n = await clearThreads()
      setNotice(n > 0 ? `已清空 ${n} 个对话` : '本来就没有对话')
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '清空失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell title="设置" onBack={() => navigate('#/records')}>
      {state.kind === 'loading' && <PageSkeleton />}
      {state.kind === 'auth' && <PageError message="访问已失效，请用新的链接重新进入。" />}
      {state.kind === 'error' && <PageError message={`没拉到设置：${state.message}`} onRetry={() => void load()} />}
      {state.kind === 'ready' && (
        <div>
          <div className="pr-grp">访问</div>
          <Row
            title="当前设备"
            value={state.data.device ? `有效至 ${fmtDate(state.data.device.expiresAt)}` : '管理端会话'}
            hint={state.data.device ? `最近使用 ${fullDayLabel(state.data.device.lastUsedAt ?? state.data.device.createdAt)}` : undefined}
          />

          <div className="pr-grp">数据</div>
          <Row title="训练记录" value={`${state.data.counts.activities} 条`} />
          <Row title="分段" value={`${state.data.counts.splits} 条`} />
          <Row title="对话" value={`${state.data.counts.threads} 个`} />
          <Row title="PR 记住的事" value={`${state.data.counts.memories} 条`} />
          <Row
            title="导出全部记录"
            hint="CSV · 含分段"
            action={
              <button type="button" className="pr-btn" onClick={() => void onExport()} disabled={busy}>
                {busy ? '处理中…' : '导出'}
              </button>
            }
          />

          <div className="pr-grp">数据源</div>
          {state.data.sources.length === 0 ? (
            <Row title="还没有数据源" hint="记录导入后这里会显示来源和最近一次同步" value="" />
          ) : (
            state.data.sources.map(s => (
              <Row key={s.source} title={s.source} value={`${s.count} 条`} hint={syncHint(s.lastAt)} />
            ))
          )}

          <div className="pr-grp">危险</div>
          <Row
            title="清空全部对话"
            hint="不可恢复，训练记录不受影响"
            danger
            action={
              <button type="button" className="pr-btn pr-btn-danger" onClick={() => void onClearThreads()} disabled={busy}>
                清空
              </button>
            }
          />

          {notice && (
            <div className="pr-meta mt-5 text-[11px]" style={{ color: 'var(--pr-text-2)' }}>
              {notice}
            </div>
          )}
        </div>
      )}
    </PageShell>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 「最近 今天」读着别扭:今天/昨天换成「今天同步」,更早的给日期 */
function syncHint(lastAt: string | null): string | undefined {
  if (!lastAt) return undefined
  const label = dayLabel(lastAt)
  return label === '今天' || label === '昨天' ? `${label}同步` : `最近 ${label}`
}

/** 设置行:左边标题(+说明),右边值或动作。用线分,不用卡片。 */
function Row({
  title,
  hint,
  value,
  action,
  danger,
}: {
  title: string
  hint?: string
  value?: string
  action?: React.ReactNode
  danger?: boolean
}) {
  return (
    <div className="flex items-center gap-3 py-3" style={{ borderBottom: '1px solid var(--pr-line)' }}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px]" style={{ color: danger ? 'var(--pr-danger)' : 'var(--pr-text)' }}>
          {title}
        </div>
        {hint && (
          <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--pr-text-2)' }}>
            {hint}
          </div>
        )}
      </div>
      {action ?? (
        <span className="pr-num shrink-0 text-[12px]" style={{ color: 'var(--pr-muted)' }}>
          {value}
        </span>
      )}
    </div>
  )
}
