/** R1 时间语义:相对→绝对日期换算、月份/周几判断、时间窗口边界与求和 —— 锚点全部由 dataset 动态派生,评测哪天跑都成立。 */
import {
  activity,
  daysAgoDate,
  DAYS_SINCE_LAST_RUN,
  LAST_RUN,
  RACE_GOAL,
  RUNNING_ACTIVITIES,
  shanghaiToday,
} from '../dataset'

import { t, type EvalCase } from './shared'

// ─── 文件内纯函数帮手(只派生日期串,不碰外部状态) ───────────────────────────

/** YYYY-MM-DD → 中文周几。 */
// Reason: 日期串是上海自然日;拼上正午 +08:00 再取 UTC 周几,宿主机在任何时区都不会把日子挪偏
function weekdayCn(dateStr: string): string {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[new Date(`${dateStr}T12:00:00+08:00`).getUTCDay()]
}

/** YYYY-MM-DD → 月份数字(1-12,用于口语表述)。 */
function monthOf(dateStr: string): number {
  return Number(dateStr.split('-')[1])
}

// ─── 由 dataset 推导的时间锚点(禁止硬编码日期或从今天口算) ──────────────────

const RACE_DATE = daysAgoDate(-RACE_GOAL.daysUntil) // 赛日 = 冻结的今天 + daysUntil
const RACE_MONTH = monthOf(RACE_DATE)
// Reason: 用 YYYY-MM 前缀比对而非裸月份数字,跨年场景(12 月 → 次年 1 月)也不会误判
const RACE_IN_THIS_MONTH = RACE_DATE.slice(0, 7) === shanghaiToday().slice(0, 7)

const LAST_RUN_DATE = daysAgoDate(LAST_RUN.daysAgo)
const LAST_RUN_WEEKDAY = weekdayCn(LAST_RUN_DATE)

const RUNS_IN_7D_COUNT = RUNNING_ACTIVITIES.filter(a => a.daysAgo <= 7).length // 0:最近一次跑步恰在窗口外 1 天
const RUNS_IN_14D = RUNNING_ACTIVITIES.filter(a => a.daysAgo <= 14) // r1 + r2
const KM_IN_14D = RUNS_IN_14D.reduce((s, a) => s + a.distanceKm, 0) // 13
const KM_IN_14D_DETAIL = RUNS_IN_14D.map(a => `${a.daysAgo} 天前 ${a.distanceKm}km`).join(' + ')

const YESTERDAY_RIDE = activity('c1') // 昨天傍晚的骑行
const YESTERDAY_HIKE = activity('h1') // 昨天上午的登山徒步——昨天有两条活动,「昨天练了啥」两条都是正确答案
const LSD_JUST_OUTSIDE_14D = activity('r3') // 15 天前的周末 LSD:两周窗口外的诱饵

export const TIME_CASES: EvalCase[] = [
  // ─────────────────────────── R1:时间语义 ───────────────────────────
  {
    id: 'time-race-absdate',
    level: 'L3',
    category: 'time/absolute-date',
    title: '半马是几月几号',
    turns: [t('哎对了,我那个半马到底是几月几号来着?')],
    judge: {
      intent: '上下文只注入相对倒计时(还有 N 天),考「相对天数→绝对日期」换算;l1-race-countdown 暴露过的真实缺陷在此钉死回归',
      mustGround: [`比赛日 ${RACE_DATE}`, `还有 ${RACE_GOAL.daysUntil} 天`],
      pass: `报出正确的具体日期 ${RACE_DATE}(等价的「X 月 X 日」口语说法算对);可顺带提还有 ${RACE_GOAL.daysUntil} 天`,
      fail: `报出与 ${RACE_DATE} 不符的日期(典型:月份换算错、或把「还有 ${RACE_GOAL.daysUntil} 天」直接当成 ${RACE_GOAL.daysUntil} 号),或被问具体日期却始终只复读倒计时不肯换算`,
      likelyReasons: ['aggregation_error', 'fabricated_fact'],
    },
  },
  {
    id: 'time-race-month',
    level: 'L3',
    category: 'time/month',
    title: '比赛是不是这个月',
    turns: [t('我比赛是不是就这个月啊?突然有点记不清了')],
    judge: {
      intent: '考月份归属判断:由倒计时推出赛日所在月份,与当前月份比较后给出一致的是/否',
      mustGround: [
        `赛日 ${RACE_DATE},在 ${RACE_MONTH} 月`,
        `今天 ${shanghaiToday()};正确答案:${RACE_IN_THIS_MONTH ? '是,就在这个月' : `不是,在 ${RACE_MONTH} 月`}`,
      ],
      pass: `明确回答「${RACE_IN_THIS_MONTH ? '是,比赛就在这个月' : `不是,比赛在 ${RACE_MONTH} 月`}」,与赛日 ${RACE_DATE} 一致;带上具体日期或倒计时更好`,
      fail: `是/否判断说反,或报出与 ${RACE_DATE} 不符的月份/日期`,
      likelyReasons: ['aggregation_error', 'wrong_readback'],
    },
  },
  {
    id: 'time-lastrun-weekday',
    level: 'L3',
    category: 'time/weekday',
    title: '上次跑步是周几',
    turns: [t('你说我上次跑步那天是周几来着?')],
    judge: {
      intent: `把最近一次跑步(${LAST_RUN.daysAgo} 天前那次)的日期换算成正确的中文周几`,
      mustGround: [`上次跑步是 ${LAST_RUN_DATE},${LAST_RUN_WEEKDAY}`],
      pass: `答出${LAST_RUN_WEEKDAY}(「星期/礼拜」等价说法算对);可带日期 ${LAST_RUN_DATE} 或那次 ${LAST_RUN.distanceKm}km 夜跑的细节`,
      fail: `周几说错,或把最近的骑行/步行当成上次跑步来算`,
      likelyReasons: ['aggregation_error', 'wrong_readback'],
    },
  },
  {
    id: 'time-past7-runs',
    level: 'L3',
    category: 'time/window-boundary',
    title: '过去一周跑了几次',
    turns: [t('过去一周我到底跑了几次步啊?')],
    judge: {
      intent: `严格 7 天窗口内跑步次数为 ${RUNS_IN_7D_COUNT}(最近一次在 ${DAYS_SINCE_LAST_RUN} 天前,恰在窗口外 1 天),考窗口边界 + 如实报零`,
      mustGround: [
        `过去 7 天跑步 ${RUNS_IN_7D_COUNT} 次`,
        `最近一次跑步已是 ${DAYS_SINCE_LAST_RUN} 天前(${LAST_RUN_DATE}),刚好在一周窗口外`,
      ],
      pass: `如实说这一周没跑过步(${RUNS_IN_7D_COUNT} 次)——这是正确答案,不是敷衍;点出最近一次是 ${DAYS_SINCE_LAST_RUN} 天前、刚出一周更好;若自报口径(如按自然周)并给出与该口径自洽的次数,也算过`,
      fail: `凭空报出跑了 N 次:把窗口内的骑行/步行当成跑步,或不说明口径就把 ${DAYS_SINCE_LAST_RUN} 天前那次硬算进「一周内」`,
      likelyReasons: ['aggregation_error', 'fabricated_fact'],
    },
  },
  {
    id: 'time-two-weeks-km',
    level: 'L3',
    category: 'time/window-aggregation',
    title: '最近两周跑量',
    turns: [t('最近两周我一共跑了多少公里啊?')],
    judge: {
      intent: `14 天窗口跑量求和:窗口内只有 ${RUNS_IN_14D.length} 次跑步共 ${KM_IN_14D}km;${LSD_JUST_OUTSIDE_14D.daysAgo} 天前的 ${LSD_JUST_OUTSIDE_14D.distanceKm}km LSD 是窗口外诱饵`,
      mustGround: [`最近 14 天跑步共 ${KM_IN_14D} km(${KM_IN_14D_DETAIL})`],
      pass: `答出 ${KM_IN_14D} 公里且对得上明细(${KM_IN_14D_DETAIL});若先讲清口径再给与口径自洽的数(如「把 ${LSD_JUST_OUTSIDE_14D.daysAgo} 天前那次 ${LSD_JUST_OUTSIDE_14D.distanceKm}km 也算上是 ${KM_IN_14D + LSD_JUST_OUTSIDE_14D.distanceKm}」)也算过`,
      fail: `不讲口径就把窗口外的 LSD 或骑行里程混进跑量、报个对不上的总数,或干脆编个数字`,
      likelyReasons: ['aggregation_error', 'fabricated_fact'],
    },
  },
  {
    id: 'time-yesterday-vs-today',
    level: 'L2',
    category: 'time/relative-day',
    title: '昨天练了啥今天呢',
    turns: [t('我昨天练了啥来着?今天呢?')],
    judge: {
      intent: `昨天(${daysAgoDate(YESTERDAY_RIDE.daysAgo)})有两条活动:上午 ${YESTERDAY_HIKE.distanceKm}km 登山徒步、傍晚 ${YESTERDAY_RIDE.distanceKm}km 骑行;今天(${shanghaiToday()})库里无任何记录,考「今天没练别编」`,
      mustGround: [
        `昨天上午登山徒步 ${YESTERDAY_HIKE.distanceKm} km、傍晚骑行 ${YESTERDAY_RIDE.distanceKm} km(提其一且类型数值正确即有据,两条都提更完整)`,
        `今天(${shanghaiToday()})没有任何运动记录`,
      ],
      pass: `昨天答出骑行 ${YESTERDAY_RIDE.distanceKm} 公里和/或徒步 ${YESTERDAY_HIKE.distanceKm} 公里(类型与数值对得上);今天如实说还没有记录/还没练——这是正确答案,不是敷衍;顺口问今天要不要安排属加分`,
      fail: `给今天编出一条运动记录,或把昨天的活动类型/里程报错`,
      likelyReasons: ['fabricated_fact', 'wrong_readback'],
    },
  },
]
