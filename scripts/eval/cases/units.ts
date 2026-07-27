/** R7 单位/数值鲁棒:公里↔英里、配速↔时速、配速大小语义、目标时间→目标配速 —— 锚点全部由 dataset 常量推导,换算方向与数值不许错。 */
import { activity, LAST_RUN, LAST_RUN_PACE_TEXT, RACE_GOAL } from '../dataset'

import { t, type EvalCase } from './shared'

// ─── 文件内纯函数帮手(只做算术换算,不碰日期/外部状态) ────────────────────

/** 秒/公里 → 4'59" 文本(dataset 的同名帮手未导出,这里写等价实现)。 */
function paceText(secPerKm: number): string {
  const total = Math.round(secPerKm)
  return `${Math.floor(total / 60)}'${String(total % 60).padStart(2, '0')}"`
}

/** 1 英里 = 1.609344 公里(国际标准换算常数,不是种子数据)。 */
const KM_PER_MILE = 1.609344

// ─── 由 dataset 推导的数值锚点(禁止硬编码从种子口算的结果) ─────────────────

// unit-miles:上次跑步 8km → ≈4.97 英里;乘除搞反的典型错答 ≈12.9 英里
const LAST_RUN_MILES = (LAST_RUN.distanceKm / KM_PER_MILE).toFixed(2)
const WRONG_MILES = (LAST_RUN.distanceKm * KM_PER_MILE).toFixed(1)

// unit-kmh:上次跑步配速 5'30"(330 秒/km)→ 3600/330 ≈ 10.9 km/h
const LAST_RUN_KMH = (3600 / LAST_RUN.paceSecPerKm!).toFixed(1)

// unit-pace-faster:节奏跑 r2 5'00" vs 上次跑 r1 5'30" —— 数值小=更快,每公里差 30 秒
const TEMPO_RUN = activity('r2')
const TEMPO_PACE_TEXT = paceText(TEMPO_RUN.paceSecPerKm!)
const PACE_DIFF_SEC = LAST_RUN.paceSecPerKm! - TEMPO_RUN.paceSecPerKm!

// unit-race-pace:目标 6300 秒 / 21.097 km ≈ 298.6 秒/km → 4'59"/km;容差带 4'58"~5'00"
const TARGET_PACE_SEC = RACE_GOAL.targetTimeSec / (RACE_GOAL.distanceMeters / 1000)
const TARGET_PACE_TEXT = paceText(TARGET_PACE_SEC)
const TARGET_PACE_LO = paceText(Math.round(TARGET_PACE_SEC) - 1)
const TARGET_PACE_HI = paceText(Math.round(TARGET_PACE_SEC) + 1)
const TARGET_H = Math.floor(RACE_GOAL.targetTimeSec / 3600)
const TARGET_M = Math.round((RACE_GOAL.targetTimeSec % 3600) / 60)

export const UNITS_CASES: EvalCase[] = [
  // ─────────────────────────── R7:单位/数值鲁棒 ───────────────────────────
  {
    id: 'unit-miles',
    level: 'L3',
    category: 'units/grounding',
    title: '公里换英里',
    turns: [t(`对了帮我算下,我上次跑的那 ${LAST_RUN.distanceKm} 公里合多少英里啊?国外网友问我,我一下卡壳了`)],
    judge: {
      intent: `公里→英里换算方向与数值:${LAST_RUN.distanceKm} km ÷ ${KM_PER_MILE} ≈ ${LAST_RUN_MILES} 英里`,
      mustGround: [`${LAST_RUN.distanceKm} km ≈ ${LAST_RUN_MILES} 英里(口语「约 5 英里」也算对)`],
      pass: `给出约 ${LAST_RUN_MILES} 英里(四舍五入说「差不多 5 英里」也算对);若顺带回读上次跑步,距离须与 ${LAST_RUN.distanceKm} km 一致`,
      fail: `换算方向搞反(答成约 ${WRONG_MILES} 英里),或结果与 ${LAST_RUN_MILES} 英里偏差 0.3 以上,或把上次跑步距离回读错`,
      likelyReasons: ['aggregation_error', 'wrong_readback'],
    },
  },
  {
    id: 'unit-kmh',
    level: 'L3',
    category: 'units/grounding',
    title: '配速换时速',
    turns: [t(`问个换算哈,我上次那个配速 ${LAST_RUN_PACE_TEXT},相当于时速多少啊?想在跑步机上照着调`)],
    judge: {
      intent: `配速→时速换算:${LAST_RUN_PACE_TEXT}/km = ${LAST_RUN.paceSecPerKm} 秒/km → 3600 ÷ ${LAST_RUN.paceSecPerKm} ≈ ${LAST_RUN_KMH} km/h`,
      mustGround: [`${LAST_RUN_PACE_TEXT}/km ≈ ${LAST_RUN_KMH} km/h(口语「约 11」也算对)`],
      pass: `给出约 ${LAST_RUN_KMH} km/h(四舍五入说「差不多 11 km/h」也算对)`,
      fail: `时速与 ${LAST_RUN_KMH} km/h 偏差 0.5 以上,或配速/速度换算关系弄反(数值量级明显不对)`,
      likelyReasons: ['aggregation_error'],
    },
  },
  {
    id: 'unit-pace-faster',
    level: 'L3',
    category: 'units/grounding',
    title: '哪个配速更快',
    turns: [t(`再问个小白问题,${TEMPO_PACE_TEXT} 和 ${LAST_RUN_PACE_TEXT} 到底哪个配速算快的?能快多少?我老被这数字绕晕`)],
    judge: {
      intent: `配速大小语义:数值小=更快;${TEMPO_PACE_TEXT} 比 ${LAST_RUN_PACE_TEXT} 每公里快 ${PACE_DIFF_SEC} 秒`,
      mustGround: [`${TEMPO_PACE_TEXT} 更快`, `每公里快 ${PACE_DIFF_SEC} 秒(说「半分钟」也算)`],
      pass: `明确说 ${TEMPO_PACE_TEXT} 更快,并给出每公里差 ${PACE_DIFF_SEC} 秒(等价口语「半分钟」也算);是否展开解释不影响判定`,
      fail: `方向说反(称 ${LAST_RUN_PACE_TEXT} 更快),或差值不是每公里 ${PACE_DIFF_SEC} 秒`,
      likelyReasons: ['aggregation_error', 'wrong_readback'],
    },
  },
  {
    id: 'unit-race-pace',
    level: 'L3',
    category: 'units/grounding',
    title: '半马目标配速',
    turns: [t(`帮我算算呗,半马想跑进 ${TARGET_H} 小时 ${TARGET_M} 分的话,平均配速得压到多少才行?`)],
    judge: {
      intent: `目标时间→目标配速:${RACE_GOAL.targetTimeSec} 秒 ÷ ${RACE_GOAL.distanceMeters / 1000} km ≈ ${Math.round(TARGET_PACE_SEC)} 秒/km,即约 ${TARGET_PACE_TEXT}/km`,
      mustGround: [`平均配速约 ${TARGET_PACE_TEXT}/km(${TARGET_PACE_LO} ~ ${TARGET_PACE_HI} 区间内的表述都算对)`],
      pass: `给出的目标配速落在 ${TARGET_PACE_LO} ~ ${TARGET_PACE_HI}/km 区间(≈${TARGET_PACE_TEXT}),且方向正确(平均配速不慢于它才进得了目标);顺带结合他的备赛近况聊不影响判定`,
      fail: `配速偏出 ${TARGET_PACE_LO} ~ ${TARGET_PACE_HI} 区间,或方向颠倒(称比 ${TARGET_PACE_HI} 更慢也能跑进 ${TARGET_H} 小时 ${TARGET_M} 分)`,
      likelyReasons: ['aggregation_error', 'fabricated_fact'],
    },
  },
]
