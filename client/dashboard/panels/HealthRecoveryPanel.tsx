import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, HeartPulse } from 'lucide-react'

import { failureMessage, isUnauthorized } from '../../lib/api'
import { cn } from '../../lib/utils'
import { ErrorState, LoadingState, RefreshButton } from '../../components/shared'
import { useApi } from '../session'

interface HealthMetric {
  date: string
  sleepMinutes: number | null
  deepSleepMinutes: number | null
  remSleepMinutes: number | null
  hrv: number | null
  restingHr: number | null
  steps: number | null
  envAudioDb: number | null
  recoveryLabel: 'good' | 'okay' | 'poor' | 'unknown'
}

const RECOVERY: Record<string, { label: string; cls: string }> = {
  good: { label: '好', cls: 'bg-emerald-500/15 text-emerald-300' },
  okay: { label: '一般', cls: 'bg-sky-500/15 text-sky-300' },
  poor: { label: '偏弱', cls: 'bg-rose-500/15 text-rose-300' },
  unknown: { label: '未知', cls: 'bg-white/10 text-white/50' },
}

function hm(min: number | null) {
  if (min == null) return '-'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m}m`
}

export function HealthRecoveryPanel() {
  const api = useApi()
  const [metrics, setMetrics] = useState<HealthMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 窄屏卡片里展开了「更多」的日期(深睡/REM/步数/环境)。
  const [expanded, setExpanded] = useState<string[]>([])

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const data = await api.json<{ metrics?: HealthMetric[] }>('/api/health/daily?limit=14')
      setMetrics(data.metrics ?? [])
      setLoadError(null)
    } catch (error) {
      if (!isUnauthorized(error)) setLoadError(failureMessage('加载健康数据', error))
    }
    setLoading(false)
    setRefreshing(false)
  }, [api])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  function toggle(date: string) {
    setExpanded(prev => (prev.includes(date) ? prev.filter(d => d !== date) : [...prev, date]))
  }

  if (loading) return <LoadingState />

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-white/80">
          <HeartPulse className="h-4 w-4" /> 近 14 天恢复
        </h3>
        <RefreshButton busy={refreshing} onClick={() => void load()} />
      </div>

      {loadError && <ErrorState message={loadError} onRetry={() => void load()} retrying={refreshing} />}

      {metrics.length ? (
        <div className={cn('transition-opacity', refreshing && 'opacity-60')}>
          {/* 宽屏:9 列全景表格 */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-white/40">
                  <th className="px-2 py-1.5 font-normal">日期</th>
                  <th className="px-2 py-1.5 font-normal">睡眠</th>
                  <th className="px-2 py-1.5 font-normal">深睡</th>
                  <th className="px-2 py-1.5 font-normal">REM</th>
                  <th className="px-2 py-1.5 font-normal">静息</th>
                  <th className="px-2 py-1.5 font-normal">HRV</th>
                  <th className="px-2 py-1.5 font-normal">步数</th>
                  <th className="px-2 py-1.5 font-normal">环境</th>
                  <th className="px-2 py-1.5 font-normal">恢复</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map(m => {
                  const rec = RECOVERY[m.recoveryLabel] ?? RECOVERY.unknown
                  return (
                    <tr key={m.date} className="border-b border-white/5 text-white/80">
                      <td className="whitespace-nowrap px-2 py-1.5 text-white/60">{m.date.slice(5)}</td>
                      <td className="px-2 py-1.5">{hm(m.sleepMinutes)}</td>
                      <td className="px-2 py-1.5 text-white/60">{hm(m.deepSleepMinutes)}</td>
                      <td className="px-2 py-1.5 text-white/60">{hm(m.remSleepMinutes)}</td>
                      <td className="px-2 py-1.5">{m.restingHr ?? '-'}</td>
                      <td className="px-2 py-1.5">{m.hrv ?? '-'}</td>
                      <td className="px-2 py-1.5">{m.steps?.toLocaleString() ?? '-'}</td>
                      <td className="px-2 py-1.5 text-white/60">{m.envAudioDb != null ? `${m.envAudioDb}dB` : '-'}</td>
                      <td className="px-2 py-1.5">
                        <span className={cn('rounded px-1.5 py-0.5 text-xs', rec.cls)}>{rec.label}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 窄屏:一天一张卡,主指标直出,其余折叠 —— 替代 560px 宽的横滚表(E9) */}
          <div className="space-y-2 sm:hidden">
            {metrics.map(m => {
              const rec = RECOVERY[m.recoveryLabel] ?? RECOVERY.unknown
              const open = expanded.includes(m.date)
              return (
                <div key={m.date} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white/70">{m.date.slice(5)}</span>
                    <span className={cn('rounded px-1.5 py-0.5 text-xs', rec.cls)}>恢复 {rec.label}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Metric label="睡眠" value={hm(m.sleepMinutes)} />
                    <Metric label="HRV" value={m.hrv != null ? String(m.hrv) : '-'} />
                    <Metric label="静息" value={m.restingHr != null ? String(m.restingHr) : '-'} />
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(m.date)}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-white/40 transition-colors hover:text-white/70"
                  >
                    <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
                    {open ? '收起' : '更多'}
                  </button>
                  {open && (
                    <div className="mt-2 grid grid-cols-2 gap-2 border-t border-white/5 pt-2">
                      <Metric label="深睡" value={hm(m.deepSleepMinutes)} />
                      <Metric label="REM" value={hm(m.remSleepMinutes)} />
                      <Metric label="步数" value={m.steps?.toLocaleString() ?? '-'} />
                      <Metric label="环境" value={m.envAudioDb != null ? `${m.envAudioDb}dB` : '-'} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        !loadError && (
          <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-white/40">
            暂无健康数据。iOS 快捷指令上报后会出现在这里。
          </p>
        )
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-white/40">{label}</p>
      <p className="text-sm tabular-nums text-white/85">{value}</p>
    </div>
  )
}
