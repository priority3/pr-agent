/**
 * 常跑地点卡片:查看/编辑 PR 环境感知用的定位(friend_profile 显式值)。
 * 显式值优先;清除后回退「最近室外活动起点聚类」自动推导。admin 无地图栈,
 * MVP 用坐标输入框 + 推导预览「采用为显式值」代替地图选点。
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Crosshair, MapPin, RefreshCw, Trash2 } from 'lucide-react'

import { cn, formatDateTime } from '../../lib/utils'
import { useToast } from '../../components/ui/toast'

import { LoadingState } from '../../components/shared'

interface ExplicitLocation {
  lat: number
  lng: number
  label?: string
  setAt: string
}

interface LocationState {
  explicit: ExplicitLocation | null
  effective: { lat: number; lng: number; label: string } | null
  source: 'explicit' | 'derived' | 'none'
}

const SOURCE_BADGE: Record<LocationState['source'], { label: string; cls: string }> = {
  explicit: { label: '显式设置', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  derived: { label: '按常跑路线推导', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  none: { label: '未知', cls: 'bg-white/10 text-white/50 border-white/15' },
}

const API_PATH = '/api/pr/profile/home-location'

export function HomeLocationCard() {
  const { success, error: toastError } = useToast()
  const [state, setState] = useState<LocationState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [latInput, setLatInput] = useState('')
  const [lngInput, setLngInput] = useState('')
  const [labelInput, setLabelInput] = useState('')

  // 服务端状态落地:显式值同步进表单,便于在现值基础上微调(加载/保存/清除后重新对齐);
  // 打字与「采用为显式值」只动表单不动 state,不会被这里覆盖。
  // Reason: useCallback 链是给 react-hooks v7 稳定性分析的证明——它不穿透普通中间函数,
  // 挂载 effect 直引普通函数会误报缺依赖,而表单同步放 effect 里又触发 set-state-in-effect。
  const applyState = useCallback((next: LocationState) => {
    setState(next)
    setLatInput(next.explicit ? String(next.explicit.lat) : '')
    setLngInput(next.explicit ? String(next.explicit.lng) : '')
    setLabelInput(next.explicit?.label ?? '')
  }, [])

  const fetchState = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(API_PATH, { cache: 'no-store' })
      if (res.ok) {
        applyState((await res.json()) as LocationState)
        setLoadError(null)
      } else {
        setLoadError(`加载常跑地点失败 (HTTP ${res.status})`)
      }
    } catch (e) {
      setLoadError(`加载常跑地点失败: ${e instanceof Error ? e.message : '网络错误'}`)
    }
    setLoading(false)
  }, [applyState])

  useEffect(() => {
    void Promise.resolve().then(fetchState)
  }, [fetchState])

  async function save() {
    // 预检只为省一次往返,规则与 API 层一致;真正的防线在 API。
    const lat = Number(latInput.trim())
    const lng = Number(lngInput.trim())
    if (latInput.trim() === '' || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      toastError('纬度需为 -90 ~ 90 的数字')
      return
    }
    if (lngInput.trim() === '' || !Number.isFinite(lng) || Math.abs(lng) > 180) {
      toastError('经度需为 -180 ~ 180 的数字')
      return
    }
    const label = labelInput.trim()
    if (label.length > 30) {
      toastError('地点名称最多 30 字')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(API_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, ...(label ? { label } : {}) }),
      })
      if (res.ok) {
        // PUT/DELETE 返回与 GET 同构的最新状态,直接落地,不再多打一次 GET。
        applyState((await res.json()) as LocationState)
        success('已保存常跑地点')
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        toastError(data?.error ?? `保存失败 (HTTP ${res.status})`)
      }
    } catch (e) {
      toastError(`保存失败: ${e instanceof Error ? e.message : '网络错误'}`)
    }
    setBusy(false)
  }

  async function clearExplicit() {
    setBusy(true)
    try {
      const res = await fetch(API_PATH, { method: 'DELETE' })
      if (res.ok) {
        applyState((await res.json()) as LocationState)
        success('已清除，回退为按常跑路线推导')
      } else {
        toastError(`清除失败 (HTTP ${res.status})`)
      }
    } catch (e) {
      toastError(`清除失败: ${e instanceof Error ? e.message : '网络错误'}`)
    }
    setBusy(false)
  }

  // 推导坐标只填进表单,不直接落库——用户看一眼、可改名,点保存才生效。
  function adoptDerived() {
    if (!state?.effective) return
    setLatInput(state.effective.lat.toFixed(5))
    setLngInput(state.effective.lng.toFixed(5))
  }

  if (loading) return <LoadingState />

  const source = state?.source ?? 'none'
  const badge = SOURCE_BADGE[source]
  const effective = state?.effective ?? null
  const explicit = state?.explicit ?? null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-white/80">
          <MapPin className="h-4 w-4" /> 常跑地点
        </h3>
        <button type="button" onClick={fetchState}
          className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10">
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </div>

      {loadError && <p className="text-sm text-rose-400">{loadError}</p>}

      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {effective ? (
              <>
                <p className="text-sm tabular-nums text-white/90">
                  {effective.lat.toFixed(5)}, {effective.lng.toFixed(5)}
                </p>
                <p className="mt-1 text-xs text-white/40">
                  {source === 'explicit' && explicit
                    ? `${explicit.label ?? '未命名'} · 设置于 ${explicit.setAt ? formatDateTime(explicit.setAt) : '时间未知'}`
                    : '来自最近室外活动起点的聚类'}
                </p>
              </>
            ) : (
              <p className="text-sm text-white/40">
                还没有可定位的常跑地点——保存显式坐标，或等有带 GPS 的室外活动后自动推导。
              </p>
            )}
          </div>
          <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-xs', badge.cls)}>{badge.label}</span>
        </div>
        {source === 'derived' && effective && (
          <button type="button" onClick={adoptDerived}
            className="mt-2 inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10">
            <Crosshair className="h-3 w-3" /> 采用为显式值
          </button>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-white/40">显式设置（优先于自动推导）</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <input value={latInput} onChange={e => setLatInput(e.target.value)}
            inputMode="decimal" placeholder="纬度，如 31.2304"
            className="w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white placeholder:text-white/30" />
          <input value={lngInput} onChange={e => setLngInput(e.target.value)}
            inputMode="decimal" placeholder="经度，如 121.4737"
            className="w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white placeholder:text-white/30" />
          <input value={labelInput} onChange={e => setLabelInput(e.target.value)}
            maxLength={30} placeholder="名称（可选），如 世纪公园"
            className="col-span-2 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white placeholder:text-white/30 sm:col-span-1" />
        </div>
        <p className="text-xs text-white/40">在地图 App 里长按目标位置即可复制经纬度，粘贴到上面。</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={save}
            className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50">
            <Check className="h-3 w-3" /> 保存
          </button>
          {explicit && (
            <button type="button" disabled={busy} onClick={clearExplicit}
              className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/50 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50">
              <Trash2 className="h-3 w-3" /> 清除（回退自动推导）
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
