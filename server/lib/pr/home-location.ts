/**
 * 常跑地点显式值的读写(friend_profile.home_location_json 单列)。
 *
 * Reason: 常跑地点是用户画像数据("我平时在哪跑步"),不是服务配置——从 app_settings
 * 的旧三键(纬度/经度/名称)迁到 friend_profile,语义归位后配置面板同步摘键。
 * 列值解析/校验只在这里做一次(坏 JSON、缺坐标、越界坐标一律按「未设置」返回 null),
 * 消费方(environment provider、面板 API)拿到的要么是合法值要么是 null,不各自防御。
 */
import { getActivitiesDb } from '@/lib/db/client'
import { friendProfile } from '@/lib/db/schema'

/** 显式常跑地点。setAt 为写入时的 ISO 时间,供面板展示"何时设置"。 */
export interface ExplicitHomeLocation {
  lat: number
  lng: number
  label?: string
  setAt: string
}

// 单行表 id 约定,与 projectFriendProfile(memory.ts)的投影写入共用同一行。
const PROFILE_ROW_ID = 'default'

function validCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/** 解析列值:任何形状问题都视为未设置,绝不把半残数据往外递。 */
function parseHomeLocation(raw: string | null | undefined): ExplicitHomeLocation | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ExplicitHomeLocation> | null
    if (!parsed || typeof parsed !== 'object') return null
    const lat = Number(parsed.lat)
    const lng = Number(parsed.lng)
    if (!validCoord(lat, lng)) return null
    return {
      lat,
      lng,
      ...(typeof parsed.label === 'string' && parsed.label.trim() ? { label: parsed.label.trim() } : {}),
      // setAt 缺失不判无效:坐标才是承重字段(只可能来自手改库,别因此丢掉合法地点)。
      setAt: typeof parsed.setAt === 'string' ? parsed.setAt : '',
    }
  } catch {
    return null
  }
}

/** 读显式常跑地点(friend_profile 单行);未设置/坏数据返回 null。 */
export async function getExplicitHomeLocation(): Promise<ExplicitHomeLocation | null> {
  const db = await getActivitiesDb()
  const rows = await db
    .select({ homeLocationJson: friendProfile.homeLocationJson })
    .from(friendProfile)
    .limit(1)
  return parseHomeLocation(rows[0]?.homeLocationJson)
}

/**
 * 写/清显式常跑地点(input 为 null 即清除,回退活动聚类推导)。
 * Reason: 只 set homeLocationJson 与 updatedAt,不触碰投影列(displayName/
 * projectionVersion 等归记忆投影 projectFriendProfile 管),与其并发写互不覆盖。
 */
export async function upsertExplicitHomeLocation(
  input: { lat: number; lng: number; label?: string } | null,
): Promise<void> {
  const value = input
    ? JSON.stringify({
        lat: input.lat,
        lng: input.lng,
        ...(input.label ? { label: input.label } : {}),
        setAt: new Date().toISOString(),
      })
    : null

  const db = await getActivitiesDb()
  await db
    .insert(friendProfile)
    .values({ id: PROFILE_ROW_ID, homeLocationJson: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: friendProfile.id,
      set: { homeLocationJson: value, updatedAt: new Date() },
    })
}
