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
