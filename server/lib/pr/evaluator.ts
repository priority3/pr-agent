import type { PrContext } from './context'

export interface EvaluationResult {
  passed: boolean
  warnings: string[]
}

/** Facts available to the chat turn, for grounding checks on the reply. */
export interface ChatEvalContext {
  hasHealth: boolean
  hasMemoryOrHabit: boolean
  doNotAssume: string[]
  /** 环境快照(天气/空气/时段)是否装配成功;失败时回复不得出现具体环境数值。 */
  hasEnvironment: boolean
  /** 今天(Asia/Shanghai,YYYY-MM-DD),赛程自洽校验的基准。 */
  today?: string
  /** 已保存赛程的绝对日期;用于抓回复里自己编的倒计时/周次/场次间隔。 */
  raceSchedule?: Array<{ name: string; city?: string | null; date: string | null }>
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dayDiff(today: string, date: string): number | null {
  const diff = Math.round((Date.parse(date) - Date.parse(today)) / 86400000)
  return Number.isFinite(diff) ? diff : null
}

/**
 * 赛程自洽:回复里给某场比赛算的倒计时、周次、两场之间的间隔,必须和背景里的绝对日期对得上。
 *
 * Reason: 线上真实事故 —— 同一段回复里同时出现「距南宁半马还有 29 天」「下周的成都赛」
 * 「两场半马隔 7 天」,三者互斥(29 天后 + 隔 7 天 ⇒ 另一场在 22 天后,不是下周)。
 * 模型的毛病是把用户原话里的「隔一周」当事实反推周次,所以这里按绝对日期硬校验一遍。
 */
function checkRaceSchedule(content: string, ctx: ChatEvalContext, warnings: string[]) {
  const today = ctx.today
  const scheduled = (ctx.raceSchedule ?? []).filter(race => race.date)
  if (!today || scheduled.length === 0) return
  const flat = content.replace(/\s+/g, '')

  // 名字太长模型会缩写成城市名(「成都马拉松」→「成都赛」),所以命中任一别名即可。
  const aliasOf = (race: { name: string; city?: string | null }) =>
    [race.name, race.city, race.name.slice(0, 4), race.name.slice(0, 2)]
      .filter((alias): alias is string => Boolean(alias && alias.length >= 2))
      .map(alias => alias.replace(/\s+/g, ''))

  for (const race of scheduled) {
    const expected = dayDiff(today, race.date!)
    if (expected == null) continue
    for (const alias of aliasOf(race)) {
      // 倒计时:别名后面 12 字内的「还有 N 天」
      const countdown = new RegExp(`${escapeRegExp(alias)}[^。；，,\\n]{0,12}?还有\\s*(\\d+)\\s*天`).exec(flat)
      if (countdown && Math.abs(Number(countdown[1]) - expected) > 1) {
        warnings.push('schedule_countdown_mismatch')
        break
      }
      // 周次:该场其实还有 10 天以上,却写成「下周」
      const weekAfter = new RegExp(`${escapeRegExp(alias)}[^。；，,\\n]{0,8}?下周`).test(flat)
      const weekBefore = new RegExp(`下周[^。；，,\\n]{0,6}?${escapeRegExp(alias)}`).test(flat)
      if (expected > 10 && (weekAfter || weekBefore)) {
        warnings.push('schedule_week_mismatch')
        break
      }
    }
  }

  // 日期还没确认的赛事:任何「下周」「还有 N 天」都是凭空推的,一律不算过。
  for (const race of (ctx.raceSchedule ?? []).filter(item => !item.date)) {
    for (const alias of aliasOf(race)) {
      const countdown = new RegExp(`${escapeRegExp(alias)}[^。；，,\\n]{0,12}?还有\\s*\\d+\\s*天`).test(flat)
      const weekAfter = new RegExp(`${escapeRegExp(alias)}[^。；，,\\n]{0,8}?下周`).test(flat)
      const weekBefore = new RegExp(`下周[^。；，,\\n]{0,6}?${escapeRegExp(alias)}`).test(flat)
      if (countdown || weekAfter || weekBefore) {
        warnings.push('schedule_week_mismatch')
        break
      }
    }
  }

  // 场次间隔:回复里出现「隔 N 天」且提到了两场有日期的比赛,就和 绝对日期差 对一遍。
  const gap = /隔\s*(\d+)\s*天/.exec(flat)
  if (gap && scheduled.length >= 2) {
    const mentioned = scheduled.filter(race => aliasOf(race).some(alias => flat.includes(alias)))
    if (mentioned.length === 2) {
      const a = dayDiff(today, mentioned[0].date!)
      const b = dayDiff(today, mentioned[1].date!)
      if (a != null && b != null && Math.abs(Math.abs(a - b) - Number(gap[1])) > 1) {
        warnings.push('schedule_gap_mismatch')
      }
    }
  }
}

/**
 * Evaluator node for chat replies (FriendPersona 输出的对话回复).
 * Chat is short and free-form, so unlike activity reviews we don't require a specific
 * fact reference or a length floor — we only guard against the failure modes the doc
 * calls out: medical claims, overconfident personality claims, repeating a user
 * correction, and asserting recovery/habit facts we don't actually have.
 */
export function evaluateChatReply(content: string, ctx: ChatEvalContext): EvaluationResult {
  const warnings: string[] = []
  if (!content.trim()) {
    return { passed: false, warnings: ['empty'] }
  }
  if (/(诊断|处方|必须吃药|停止所有运动|严重疾病)/.test(content)) {
    warnings.push('medical_risk_language')
  }
  if (/(你就是|你一直|你总是|性格|天生|肯定是)/.test(content)) {
    warnings.push('overconfident_personality_claim')
  }
  for (const correction of ctx.doNotAssume) {
    const tokens = correction
      .replace(/[，。！？,.!?]/g, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 3)
      .slice(0, 4)
    if (tokens.length > 0 && tokens.every(token => content.includes(token))) {
      warnings.push('violates_user_correction')
      break
    }
  }
  if (!ctx.hasHealth && /(睡眠|HRV|静息心率|恢复状态)/.test(content)) {
    warnings.push('unsupported_recovery_claim')
  }
  if (!ctx.hasMemoryOrHabit && /(你习惯|你喜欢|你通常|你经常|老习惯)/.test(content)) {
    warnings.push('unsupported_habit_claim')
  }
  // 环境数值 grounding:没有环境数据时,带具体数值的天气/空气断言就是编造。
  // Reason: 只拦「数值级」断言(几度/AQI 多少/降水概率),"下雨路滑"这类世界常识不拦。
  if (!ctx.hasEnvironment && /(\d+\s*°C|\d+\s*度[以上下]?[的时]?(?:高温|低温)|AQI\s*\d+|降水概率|降雨概率|PM2\.5\s*\d+)/.test(content)) {
    warnings.push('unsupported_environment_claim')
  }
  checkRaceSchedule(content, ctx, warnings)
  return { passed: warnings.length === 0, warnings }
}

export function evaluateActivityReview(content: string, context: PrContext): EvaluationResult {
  const warnings: string[] = []
  const summary = context.activity.summary
  const concreteSignals = [
    summary.distanceKm.toFixed(2),
    summary.averageHeartRate == null ? null : String(summary.averageHeartRate),
    summary.maxHeartRate == null ? null : String(summary.maxHeartRate),
    context.activity.pace.fastestKm == null ? null : `第 ${context.activity.pace.fastestKm}`,
    context.activity.moments[0]?.label ?? null,
  ].filter(Boolean) as string[]

  if (!concreteSignals.some(signal => content.includes(signal))) {
    warnings.push('missing_activity_fact_reference')
  }

  if (/(诊断|处方|必须吃药|停止所有运动|严重疾病)/.test(content)) {
    warnings.push('medical_risk_language')
  }

  if (/(你就是|你一直|你总是|性格|天生|肯定是)/.test(content)) {
    warnings.push('overconfident_personality_claim')
  }

  for (const correction of context.companionProfile.doNotAssume) {
    const tokens = correction
      .replace(/[，。！？,.!?]/g, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 3)
      .slice(0, 4)
    if (tokens.length > 0 && tokens.every(token => content.includes(token))) {
      warnings.push('violates_user_correction')
      break
    }
  }

  if (context.healthDailyMetrics.length === 0 && /(睡眠|HRV|静息心率|恢复状态)/.test(content)) {
    warnings.push('unsupported_recovery_claim')
  }

  if (context.memoryItems.length === 0 && context.trainingHabitSignals.length === 0 && /(你习惯|你喜欢|你通常|你经常|老习惯)/.test(content)) {
    warnings.push('unsupported_habit_claim')
  }

  if (content.length < 120) {
    warnings.push('too_short')
  }

  return {
    passed: warnings.length === 0,
    warnings,
  }
}
