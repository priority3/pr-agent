/**
 * 运行时配置读取:env 为基底,AI 网关白名单键可被库内覆盖(runtime-overrides.ts)。
 *
 * Reason: 抽离时配置收敛为纯 env;后来宿主面板需要能改 AI 网关(url/key/model)
 * 且免重启,于是给**白名单 8 键**开了库内覆盖通路——鉴权/拓扑类键仍只认 env,
 * 见 runtime-overrides.ts 的边界说明。保持 getRuntimeSettings/getRuntimeSetting
 * 签名不变,存量调用方零改动。
 *
 * 缓存:覆盖读取带 30s TTL(auth 中间件每请求都会读配置,不能每次打库);
 * 写入口(routes/settings.ts)保存后调 invalidateRuntimeOverridesCache() 即时生效。
 * callPrModel 传的 { force:true } 同样绕过缓存——模型调用频率低,换来改完即用。
 */
import { readOverrides } from './runtime-overrides'

const CACHE_TTL_MS = 30_000
let overrideCache: { values: Record<string, string>; expiresAt: number } | null = null

export function invalidateRuntimeOverridesCache() {
  overrideCache = null
}

async function getOverrides(force: boolean): Promise<Record<string, string>> {
  if (!force && overrideCache && overrideCache.expiresAt > Date.now()) return overrideCache.values
  const values = await readOverrides()
  overrideCache = { values, expiresAt: Date.now() + CACHE_TTL_MS }
  return values
}

export async function getRuntimeSettings(
  opts: { force?: boolean } = {},
): Promise<Record<string, string>> {
  const settings: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') settings[k] = v
  }
  // 库内覆盖(仅白名单键,非空才生效)压过 env。
  const overrides = await getOverrides(opts.force === true)
  for (const [k, v] of Object.entries(overrides)) {
    if (v) settings[k] = v
  }
  return settings
}

export async function getRuntimeSetting(key: string): Promise<string> {
  const settings = await getRuntimeSettings()
  return settings[key] ?? ''
}
