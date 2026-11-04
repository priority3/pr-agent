/**
 * 训练数据的展示格式化。
 *
 * 一条原则:所有会随数据变化的数字都要能被「竖着比较」——所以这里的输出一律交给
 * 带 tabular-nums 的容器渲染(见 theme.tsx 的 .pr-num),配速、心率、距离换行时不会左右抖。
 */
import type { RecordItem } from './types'

/** 米 → 公里,1 位小数(10.0 而不是 10,列对齐才整齐) */
export function km(meters: number): string {
  return (meters / 1000).toFixed(1)
}

/** 秒/公里 → 6'12";没有配速返回 — */
export function pace(secPerKm: number | null): string {
  if (!secPerKm || !Number.isFinite(secPerKm)) return '—'
  const total = Math.round(secPerKm)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}'${String(s).padStart(2, '0')}"`
}

/** 秒 → 42:15 / 1:08:30 */
export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.round(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 周一为一周起点(与后端 week.start 一致) */
export function startOfWeek(d: Date): Date {
  const base = startOfDay(d)
  base.setDate(base.getDate() - ((base.getDay() + 6) % 7))
  return base
}

/** 列表右侧的时间:今天 / 昨天 / 11-02 */
export function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = startOfDay(new Date()).getTime()
  const that = startOfDay(d).getTime()
  const diff = Math.round((today - that) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 详情页副标题:11月4日 07:12 · 42 分钟 */
export function fullDayLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 类型 → 行首那个字 */
export function typeMark(type: string): string {
  switch (type) {
    case 'running':
      return '跑'
    case 'cycling':
      return '骑'
    case 'walking':
      return '走'
    case 'swimming':
      return '泳'
    default:
      return '练'
  }
}

/** 一行的第二层信息:配速 · 心率 · 爬升(有什么写什么,不留空占位) */
export function rowSub(item: RecordItem): string {
  const parts: string[] = []
  if (item.averagePace) parts.push(`配速 ${pace(item.averagePace)}`)
  if (item.averageHeartRate) parts.push(`心率 ${item.averageHeartRate}`)
  if (item.elevationGain && item.elevationGain > 0) parts.push(`爬升 ${Math.round(item.elevationGain)}m`)
  return parts.join(' · ') || '无详细数据'
}

/**
 * 按周分组:本周 / 上周 / 更早。
 * 用后端给的 week.start 作基准,而不是前端自己算——跨月、跨年、时区都以后端为准,
 * 否则列表里会出现「本周」和「上周」的边界互相矛盾。
 */
export function groupByWeek(items: RecordItem[], weekStartIso: string): { label: string; items: RecordItem[] }[] {
  const base = startOfWeek(new Date(weekStartIso)).getTime()
  const buckets: { label: string; items: RecordItem[] }[] = [
    { label: '本周', items: [] },
    { label: '上周', items: [] },
    { label: '更早', items: [] },
  ]
  for (const item of items) {
    const weeksAgo = Math.floor((base - startOfWeek(new Date(item.startTime)).getTime()) / (7 * 86400000))
    if (weeksAgo <= 0) buckets[0].items.push(item)
    else if (weeksAgo === 1) buckets[1].items.push(item)
    else buckets[2].items.push(item)
  }
  return buckets.filter(b => b.items.length > 0)
}
