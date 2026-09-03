/**
 * 运行时配置覆盖:AI 网关(url/key/model)从宿主面板可改、即时生效、免重启。
 *
 * 边界(与「配置全部来自 env」原则的妥协点,刻意收窄):
 * - **白名单硬编码**:只有 AI 网关 8 键可覆盖。鉴权类(ADMIN 系、HEALTH_IMPORT_TOKEN、
 *   LORE_INGEST_TOKEN)与拓扑类(DATABASE_URL)永远只认 env——库内数据被篡改
 *   也动不了鉴权与数据面。
 * - **密文落库**(crypto.encryptValue):业务库会被快照/实时复制到对象存储,
 *   明文密钥不允许进备份链路。
 * - 值为空串 = 清除覆盖(回落 env);读取失败(未建表/密钥未配)静默回落 env。
 */
import { eq, inArray } from 'drizzle-orm'

import { decryptValue, encryptValue } from './crypto'
import { getActivitiesDb } from './db/client'
import { runtimeSettings } from './db/schema'

export const OVERRIDABLE_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_VISION_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
] as const
export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number]

/** 值含密钥语义的键(读取接口只回尾 4 位预览,不回明文)。 */
const SECRET_KEYS = new Set<OverridableKey>(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])

export function isOverridableKey(key: string): key is OverridableKey {
  return (OVERRIDABLE_KEYS as readonly string[]).includes(key)
}

/** 读全部覆盖(解密后明文,供 config 合并)。任一环节失败返回空表——配置读取不能炸。 */
export async function readOverrides(): Promise<Record<string, string>> {
  try {
    const db = await getActivitiesDb()
    const rows = await db
      .select()
      .from(runtimeSettings)
      .where(inArray(runtimeSettings.key, [...OVERRIDABLE_KEYS]))
    const overrides: Record<string, string> = {}
    for (const row of rows) {
      try {
        const value = decryptValue(row.valueEncrypted)
        if (value) overrides[row.key] = value
      } catch (error) {
        // 单键解密失败(如换过 SETTINGS_ENCRYPTION_KEY)只丢该键,不拖累其他覆盖。
        console.warn(`[runtime-overrides] 解密 ${row.key} 失败,回落 env:`, (error as Error).message)
      }
    }
    return overrides
  } catch {
    return {}
  }
}

/** 写/清除一个覆盖(空串 = 删除记录,回落 env)。 */
export async function setOverride(key: OverridableKey, value: string): Promise<void> {
  const db = await getActivitiesDb()
  const trimmed = value.trim()
  if (!trimmed) {
    await db.delete(runtimeSettings).where(eq(runtimeSettings.key, key))
    return
  }
  const valueEncrypted = encryptValue(trimmed)
  await db
    .insert(runtimeSettings)
    .values({ key, valueEncrypted, updatedAt: new Date() })
    .onConflictDoUpdate({ target: runtimeSettings.key, set: { valueEncrypted, updatedAt: new Date() } })
}

export interface OverrideView {
  key: OverridableKey
  /** override = 库内覆盖生效;env = 回落环境变量;unset = 两处都空。 */
  source: 'override' | 'env' | 'unset'
  /** 非密钥键回完整值;密钥键只回尾 4 位。 */
  preview: string | null
}

/** 面板展示视图:永不返回密钥明文。 */
export async function listOverrideViews(): Promise<OverrideView[]> {
  const overrides = await readOverrides()
  return OVERRIDABLE_KEYS.map(key => {
    const override = overrides[key]
    const envValue = (process.env[key] ?? '').trim()
    const effective = override || envValue
    const source = override ? ('override' as const) : envValue ? ('env' as const) : ('unset' as const)
    const preview = !effective ? null : SECRET_KEYS.has(key) ? `…${effective.slice(-4)}` : effective
    return { key, source, preview }
  })
}
