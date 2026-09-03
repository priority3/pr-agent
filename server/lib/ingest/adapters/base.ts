/**
 * 活动数据的统一入参形状。
 *
 * 直采 Keep/Strava 的适配器已移除 —— 那是 runPaceFlow-admin 的职责(它写 activities,
 * 本进程读同一个库)。本文件现在只定义「一条活动长什么样」,供通用导入端点与处理器共用。
 */

/**
 * 原始活动数据（统一格式）
 *
 * 这也是通用导入端点 POST /api/activities/import 的请求体形状:
 * 无第三方账号的用户可直接构造 RawActivity 喂入(startTime 用 ISO 字符串)。
 */
export interface RawActivity {
  /** 活动 ID */
  id: string
  /** 活动标题 */
  title: string
  /** 活动类型 */
  type: 'running' | 'cycling' | 'walking' | 'swimming' | 'other'
  /** 是否室内活动（跑步机等） */
  isIndoor?: boolean
  /** 开始时间 */
  startTime: Date
  /** 持续时间（秒） */
  duration: number
  /** 距离（米） */
  distance: number
  /** GPX 数据（可选） */
  gpxData?: string
  /** 平均配速（秒/公里）（可选） */
  averagePace?: number
  /** 最快配速（秒/公里）（可选） */
  bestPace?: number
  /** 海拔上升（米）（可选） */
  elevationGain?: number
  /** 平均心率（可选） */
  averageHeartRate?: number
  /** 最大心率（可选） */
  maxHeartRate?: number
  /** 卡路里（可选） */
  calories?: number
  /** 数据来源 */
  source: string
}
