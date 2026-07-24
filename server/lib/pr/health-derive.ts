/**
 * Health payload derivation.
 *
 * Reason: reporters (iOS Shortcuts) upload RAW sleep facts — one entry per sleep
 * sample with its stage and start/end times — plus daytime nap samples. The server
 * derives the aggregate recovery numbers (asleep/deep/REM minutes, nap total,
 * bedtime/wake, awakenings) so the raw facts stay intact and the interpretation
 * logic can evolve without changing the shortcut on the user's phone.
 */

export interface SleepSegmentInput {
  stage?: unknown
  start?: unknown
  end?: unknown
  minutes?: unknown
}

export type SleepStage = 'deep' | 'rem' | 'core' | 'inbed' | 'awake' | 'other'

/** Map Apple's stage label (In Bed / Core / Deep / REM / Awake) to a bucket. */
export function classifyStage(stage: string): SleepStage {
  const s = stage.toLowerCase()
  if (s.includes('deep')) return 'deep'
  if (s.includes('rem')) return 'rem'
  if (s.includes('core') || s.includes('asleep')) return 'core'
  if (s.includes('bed')) return 'inbed'
  if (s.includes('awake') || s.includes('wake')) return 'awake'
  return 'other'
}

/** Duration of a segment in minutes, from explicit `minutes` or start/end timestamps. */
export function segmentMinutes(seg: SleepSegmentInput): number {
  if (typeof seg.minutes === 'number' && Number.isFinite(seg.minutes)) return seg.minutes
  const start = typeof seg.start === 'string' ? Date.parse(seg.start) : NaN
  const end = typeof seg.end === 'string' ? Date.parse(seg.end) : NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return (end - start) / 60000
  }
  return 0
}

function asArray(value: unknown): SleepSegmentInput[] {
  return Array.isArray(value) ? (value as SleepSegmentInput[]) : []
}

/**
 * Local hour (Asia/Shanghai) of an ISO timestamp, or null if unparseable.
 * Used to separate night sleep from daytime naps when the reporter uploads a
 * rolling 24h window (which, at wake time, also contains the previous day's naps).
 */
function shanghaiHour(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return null
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(t))
  const n = parseInt(h, 10)
  return Number.isFinite(n) ? n % 24 : null
}

/** A start hour (CST) between 12:00 and 20:00 marks a daytime nap. */
function isNapHour(hour: number | null): boolean {
  return hour != null && hour >= 12 && hour < 20
}

// Only sleep starting within this window before the latest wake counts as "last night".
const NIGHT_WINDOW_MS = 14 * 60 * 60 * 1000

export interface DerivedSleep {
  sleepMinutes: number | null
  deepSleepMinutes: number | null
  remSleepMinutes: number | null
  coreMinutes: number
  inBedMinutes: number
  awakeMinutes: number
  awakenings: number
  bedtime: string | null
  wakeTime: string | null
  napMinutes: number
}

/**
 * Derive recovery aggregates from raw night-sleep + daytime-nap segments.
 * "Asleep" = Core + Deep + REM (excludes In Bed and Awake), matching Apple's model.
 */
export function deriveSleep(sleepSegments: unknown, extraNapSegments?: unknown): DerivedSleep {
  const parsed = asArray(sleepSegments).map((seg) => {
    const cls = classifyStage(typeof seg.stage === 'string' ? seg.stage : '')
    return {
      cls,
      minutes: segmentMinutes(seg),
      startMs: typeof seg.start === 'string' ? Date.parse(seg.start) : NaN,
      endMs: typeof seg.end === 'string' ? Date.parse(seg.end) : NaN,
      napHour: isNapHour(shanghaiHour(seg.start)),
      asleep: cls === 'deep' || cls === 'rem' || cls === 'core',
    }
  })

  // Daytime naps (start 12:00–20:00 CST) are pulled out so the night total stays clean.
  let napMinutes = parsed
    .filter((p) => p.napHour && p.asleep)
    .reduce((sum, p) => sum + p.minutes, 0)
  napMinutes += asArray(extraNapSegments).reduce((sum, seg) => sum + segmentMinutes(seg), 0)

  // A rolling 24h upload can span two nights; keep only the most recent night —
  // segments starting within NIGHT_WINDOW_MS before the latest night-time wake.
  const nightCandidates = parsed.filter((p) => !p.napHour)
  const nightEnds = nightCandidates.map((p) => p.endMs).filter((n) => Number.isFinite(n))
  const cutoff = nightEnds.length ? Math.max(...nightEnds) - NIGHT_WINDOW_MS : -Infinity
  const night = nightCandidates.filter((p) => !Number.isFinite(p.startMs) || p.startMs >= cutoff)

  let deep = 0
  let rem = 0
  let core = 0
  let inbed = 0
  let awake = 0
  let awakenings = 0
  const asleepStarts: number[] = []
  const asleepEnds: number[] = []
  for (const p of night) {
    if (p.cls === 'deep') deep += p.minutes
    else if (p.cls === 'rem') rem += p.minutes
    else if (p.cls === 'core') core += p.minutes
    else if (p.cls === 'inbed') inbed += p.minutes
    else if (p.cls === 'awake') {
      awake += p.minutes
      awakenings += 1
    }
    if (p.asleep) {
      if (Number.isFinite(p.startMs)) asleepStarts.push(p.startMs)
      if (Number.isFinite(p.endMs)) asleepEnds.push(p.endMs)
    }
  }

  const asleep = core + deep + rem
  const hasNight = night.length > 0
  const round = (n: number) => Math.round(n)

  return {
    sleepMinutes: hasNight ? round(asleep) : null,
    deepSleepMinutes: hasNight ? round(deep) : null,
    remSleepMinutes: hasNight ? round(rem) : null,
    coreMinutes: round(core),
    inBedMinutes: round(inbed),
    awakeMinutes: round(awake),
    awakenings,
    bedtime: asleepStarts.length ? new Date(Math.min(...asleepStarts)).toISOString() : null,
    wakeTime: asleepEnds.length ? new Date(Math.max(...asleepEnds)).toISOString() : null,
    napMinutes: round(napMinutes),
  }
}
