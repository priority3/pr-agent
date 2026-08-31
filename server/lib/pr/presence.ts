/**
 * 实时状态(P3):只读接入 priority.me 的 Presence 端点。
 *
 * 短时层与持久特征彻底分离:presence 永不落库、永不进 traits(「正在用 VS Code」
 * 没有确认语义,也不该沉淀)。这里只做服务端拉取 + 内存缓存 + 词表映射,
 * 渲染端拿到的是已经翻译好的中文短语。
 *
 * 上游契约(priority.me GET /api/presence,公开已脱敏):
 *   { online, processName, processInfo{name,description}, mediaInfo{title,artist}, timestamp, serverNow }
 * ProcessReporter 每 ~30s 上报一次,站点侧 TTL 5 分钟。
 * 设计:claudedocs/persona-avatar-design.md §7
 */

export interface PersonaLive {
  /** false = 未配置 PR_PRESENCE_URL,面板应整体隐藏状态条。 */
  enabled: boolean
  online: boolean
  /** 「写码中」「冲浪中」等词表短语;离线/未知为 null。 */
  doing: string | null
  /** 原始应用名(词表兜底句和悬浮提示用)。 */
  app: string | null
  /** 「听 {title} · {artist}」;无媒体为 null。 */
  listening: string | null
  /** 上游最近一次上报时间(epoch ms);离线为 null。 */
  at: number | null
}

/** 进程名 → 状态短语词表。按序匹配,命中即止;没命中兜底「在用 {name}」。 */
const DOING_RULES: Array<[RegExp, string]> = [
  [/code|cursor|zed|intellij|webstorm|xcode/i, '写码中'],
  [/iterm|terminal|warp|ghostty|alacritty/i, '敲终端中'],
  [/chrome|safari|arc|edge|firefox/i, '冲浪中'],
  [/wechat|微信|telegram|slack|discord/i, '聊天中'],
  [/notion|obsidian|craft|typora|bear/i, '记笔记中'],
  [/keynote|pages|numbers|word|excel|powerpoint|wps/i, '办公中'],
  [/music|spotify|podcasts|网易云/i, '听歌中'],
  [/figma|sketch|photoshop|blender/i, '画图中'],
]

function mapDoing(processName: string | null): string | null {
  if (!processName) return null
  for (const [pattern, label] of DOING_RULES) {
    if (pattern.test(processName)) return label
  }
  return `在用 ${processName}`
}

interface UpstreamPresence {
  online?: boolean
  processName?: string | null
  mediaInfo?: { title?: string | null; artist?: string | null } | null
  timestamp?: number | null
}

const OFFLINE: Omit<PersonaLive, 'enabled'> = { online: false, doing: null, app: null, listening: null, at: null }

// 30s 内存缓存:presence 本身 ~30s 上报一次,更频繁地打上游没有信息增量。
const CACHE_TTL_MS = 30_000
let cache: { value: PersonaLive; expiresAt: number } | null = null

export async function getPersonaLive(): Promise<PersonaLive> {
  const url = (process.env.PR_PRESENCE_URL ?? '').trim()
  if (!url) return { enabled: false, ...OFFLINE }
  if (cache && cache.expiresAt > Date.now()) return cache.value

  let value: PersonaLive
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`presence 上游返回 ${response.status}`)
    const raw = (await response.json()) as UpstreamPresence
    const app = raw.processName?.trim() || null
    const title = raw.mediaInfo?.title?.trim() || null
    const artist = raw.mediaInfo?.artist?.trim() || null
    value = {
      enabled: true,
      online: raw.online === true,
      doing: raw.online === true ? mapDoing(app) : null,
      app,
      listening: title ? `听 ${title}${artist ? ` · ${artist}` : ''}` : null,
      // 上游 timestamp 是 Unix 秒(ProcessReporter 约定),统一成 ms。
      at: typeof raw.timestamp === 'number' ? raw.timestamp * 1000 : null,
    }
  } catch (error) {
    // 上游抖动降级为「离线」,不向上抛——状态条消失比面板报错体验好。
    console.warn('[persona-live] presence 拉取失败:', (error as Error).message)
    value = { enabled: true, ...OFFLINE }
  }

  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
  return value
}
