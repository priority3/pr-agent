import type { DailyContext, PrContext, RecentActivityContext } from './context'
import { raceGoalSummary } from './race-goals'

export const PR_REVIEW_PROMPT_VERSION = 'pr-activity-review-v1'
export const PR_DAILY_PROMPT_VERSION = 'pr-daily-review-v3'

function formatPace(pace: number | null) {
  if (!pace || pace <= 0) return '-'
  const minutes = Math.floor(pace / 60)
  const seconds = Math.round(pace % 60)
  return `${minutes}'${seconds.toString().padStart(2, '0')}"`
}

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}小时${m}分${s}秒`
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

export function buildPrActivityReviewSystemPrompt() {
  return `你是 RunPaceFlow 的 PR，一位长期陪伴用户运动的伙伴型 Agent（跑步、骑行、力量、徒步都聊得来）。

请用中文生成运动后复盘。语气像熟悉用户的运动伙伴：真诚、具体、克制，不要像生硬报表。

严格要求：
- 只能基于输入 facts/context 说话，不要编造用户偏好、伤病、目标或生活状态。
- 只有「长期记忆」「伙伴画像」「候选习惯信号」里出现的内容才能表达为了解用户；候选信号要用“看起来/近期样本显示”，不要说成确定性格。
- 如果存在“不要默认/纠正”内容，必须避开对应判断，不要用另一种说法重复犯错。
- 必须引用本次活动里的具体距离、配速、心率、天气、分段或 moments。
- 可以给训练建议，但不要做医学诊断。
- 不要在结尾追问用户补数据。
- 回复长度控制在 220-420 字。
- 使用 Markdown，最多 3 个小段落或短列表。`
}

export function buildPrActivityReviewUserPrompt(context: PrContext) {
  const { activity, recentTraining, raceGoals, healthDailyMetrics } = context
  const summary = activity.summary

  return `请为这次活动生成 PR 跑后复盘。

## 本次活动事实
- 标题：${summary.title}
- 类型：${summary.type}
- 开始时间：${summary.startTime}
- 距离：${summary.distanceKm.toFixed(2)} km
- 用时：${formatDuration(summary.durationSec)}
- 平均配速：${formatPace(summary.averagePaceSecPerKm)}/km
- 平均心率：${summary.averageHeartRate ?? '-'} bpm
- 最高心率：${summary.maxHeartRate ?? '-'} bpm
- 爬升：${summary.elevationGain ?? '-'} m
- 天气：${summary.weatherDescription ?? '-'}

## 配速与努力特征
- 趋势：${activity.pace.trend}
- 前半程均配：${formatPace(activity.pace.firstHalfAvgPace)}/km
- 后半程均配：${formatPace(activity.pace.secondHalfAvgPace)}/km
- 最快公里：${activity.pace.fastestKm ?? '-'}
- 最慢公里：${activity.pace.slowestKm ?? '-'}
- 疲劳信号：${activity.effort.fatigueSignal}
- 心率备注：${activity.effort.heartRateNote ?? '-'}

## 分段
${activity.splits
  .slice(0, 25)
  .map(split => `- 第 ${split.kilometer} 公里：${formatPace(split.pace)}/km${split.averageHeartRate ? `，${split.averageHeartRate} bpm` : ''}`)
  .join('\n') || '- 无分段数据'}

## 观察 moments
${activity.moments.map(moment => `- ${moment.label}：${moment.content}`).join('\n') || '- 暂无显著 moments'}

## 近 ${recentTraining.days} 天同类型训练
- 活动数：${recentTraining.activities}
- 总里程：${recentTraining.distanceKm.toFixed(2)} km
- 最长单次：${recentTraining.longestDistanceKm.toFixed(2)} km

## 相关比赛目标
${raceGoals
  .map(goal => {
    const target = goal.targetTimeSec ? `，目标时间 ${formatDuration(goal.targetTimeSec)}` : ''
    const notes = goal.notes ? `，备注：${goal.notes}` : ''
    return `- ${goal.name}｜${goal.distanceMeters / 1000} km｜${goal.raceDate}｜${goal.daysUntilRace} 天后${target}${notes}`
  })
  .join('\n') || '- 暂无 active 比赛目标'}

## 恢复数据
${healthDailyMetrics
  .map(metric => {
    const pieces = [
      `日期 ${metric.date}`,
      metric.sleepMinutes != null ? `睡眠 ${metric.sleepMinutes} 分钟` : null,
      metric.deepSleepMinutes != null ? `深睡 ${metric.deepSleepMinutes} 分钟` : null,
      metric.remSleepMinutes != null ? `REM ${metric.remSleepMinutes} 分钟` : null,
      metric.hrv != null ? `HRV ${metric.hrv}` : null,
      metric.restingHr != null ? `静息心率 ${metric.restingHr}` : null,
      `恢复状态 ${metric.recoveryLabel}`,
    ].filter(Boolean)
    return `- ${pieces.join('，')}（来源：${metric.source}）`
  })
  .join('\n') || '- 暂无恢复数据'}

## 用户主观反馈
${context.subjectiveFeedback
  .map(feedback => {
    const parts = [
      feedback.rpe ? `RPE ${feedback.rpe}/10` : null,
      feedback.mood ? `心情/体感：${feedback.mood}` : null,
      feedback.pain ? `疼痛/不适：${JSON.stringify(feedback.pain)}` : null,
      feedback.note ? `备注：${feedback.note}` : null,
    ].filter(Boolean)
    return `- ${parts.join('；')}（${feedback.createdAt}）`
  })
  .join('\n') || '- 暂无'}

## 可引用的长期记忆
${context.memoryItems
  .map(memory => `- [${memory.type}｜confidence ${memory.confidence.toFixed(2)}] ${memory.content}`)
  .join('\n') || '- 暂无 active 记忆'}

## 伙伴画像投影
- 称呼：${context.companionProfile.displayName ?? '-'}
- 陪伴风格：${context.companionProfile.companionStyle.join('；') || '-'}
- 当前目标：${context.companionProfile.activeGoals.join('；') || '-'}
- 训练偏好/风险模式：${context.companionProfile.trainingPreferences.join('；') || '-'}
- 伤痛观察：${context.companionProfile.injuryWatchlist.join('；') || '-'}
- 不应再默认：${context.companionProfile.doNotAssume.join('；') || '-'}

## 候选习惯信号
${context.trainingHabitSignals
  .map(signal => `- [${signal.type}｜confidence ${signal.confidence.toFixed(2)}] ${signal.label}：${signal.content}`)
  .join('\n') || '- 暂无足够稳定的候选习惯信号'}

## 可引用训练知识
${context.retrievedKnowledge
  .map(item => `- [${item.id}] ${item.content.slice(0, 360)}${item.content.length > 360 ? '...' : ''}${item.source ? `（来源：${item.source}）` : ''}`)
  .join('\n') || '- 暂无命中知识库'}

请输出：
1. 一句整体评价。
2. 结合具体数据解释本次节奏/努力。
3. 给 1-2 条下一次训练建议。

不要追问。`
}

export function buildRuleBasedPrReview(context: PrContext) {
  const { activity, recentTraining, raceGoals, healthDailyMetrics } = context
  const summary = activity.summary
  const trendLabel =
    activity.pace.trend === 'negative_split'
      ? '后程加速'
      : activity.pace.trend === 'positive_split'
        ? '后程放缓'
        : activity.pace.trend === 'steady'
          ? '节奏比较稳'
          : '节奏数据还不完整'
  const momentText = activity.moments[0]
    ? `${activity.moments[0].label}：${activity.moments[0].content}`
    : '这次没有特别尖锐的异常点，适合作为一次稳定样本记录下来。'

  const heartRateText = summary.averageHeartRate
    ? `心率这边平均 ${summary.averageHeartRate} bpm${summary.maxHeartRate ? `、最高 ${summary.maxHeartRate} bpm` : ''}`
    : '心率数据暂时不完整'

  const latestFeedback = context.subjectiveFeedback[0]
  const latestGoal = raceGoals[0]
  const latestHealth = healthDailyMetrics[0]
  const habitSignal = context.trainingHabitSignals[0]
  const knowledge = context.retrievedKnowledge[0]
  const memoryText = context.memoryItems.length
    ? `另外，已确认的长期记忆里有 ${context.memoryItems.slice(0, 2).map(memory => memory.content).join('；')}。`
    : ''
  const profileText = context.companionProfile.trainingPreferences.length
    ? `按当前伙伴画像，训练偏好/风险里值得参考的是 ${context.companionProfile.trainingPreferences.slice(0, 2).join('；')}。`
    : ''
  const habitText = habitSignal
    ? `近期样本还提示：${habitSignal.content}`
    : ''
  const goalText = latestGoal
    ? `当前更近的比赛目标是 ${latestGoal.name}，还有 ${latestGoal.daysUntilRace} 天。`
    : ''
  const healthText = latestHealth
    ? `最近恢复数据里，${latestHealth.date} 的状态是 ${latestHealth.recoveryLabel}，睡眠 ${latestHealth.sleepMinutes ?? '未知'} 分钟。`
    : ''
  const feedbackText = latestFeedback
    ? `你补充的主观反馈是 ${[
        latestFeedback.rpe ? `RPE ${latestFeedback.rpe}/10` : null,
        latestFeedback.mood ? latestFeedback.mood : null,
        latestFeedback.note ? latestFeedback.note : null,
      ]
        .filter(Boolean)
        .join('，')}，这比单看配速更能说明当时状态。`
    : ''
  const knowledgeText = knowledge
    ? `知识库里也有相关参考：${knowledge.content.slice(0, 90)}。`
    : ''

  return `这次 ${summary.title} 完成了 **${summary.distanceKm.toFixed(2)} km**，用时 **${formatDuration(summary.durationSec)}**，平均配速 **${formatPace(summary.averagePaceSecPerKm)}/km**，整体看是一次${trendLabel}的训练。

${momentText} ${heartRateText}${summary.weatherDescription ? `，天气是 ${summary.weatherDescription}` : ''}。${goalText}${healthText}${feedbackText}${memoryText}${profileText}${habitText}${knowledgeText} 近 ${recentTraining.days} 天同类型活动有 ${recentTraining.activities} 次、累计 ${recentTraining.distanceKm.toFixed(2)} km，这次可以放进最近训练节奏里一起看。

下一次建议保持前半程更克制一点，把主要发力留给后半段；如果主观疲劳偏高，就把目标从“提速”换成“稳定完成”，优先守住连续性。`
}

// ─── 每日恢复反思(健康驱动) ──────────────────────────────────────────────

export function buildDailyReviewSystemPrompt() {
  return `你是 PR，用户的运动伙伴、挺懂他的一个朋友。用户刚睡醒，你看了他的身体数据，像发微信一样随口跟他说句话。

你不是在写晨间报告，是在跟朋友搭话。记住：
- 只挑今天最值得说的那一点说——睡得特别好或特别差、HRV 掉了、连着熬夜、步数反常、离比赛没几天了……数据是你观察的依据，不是要念给他听的清单。没什么特别的，就轻描淡写一句。
- 像真人发消息：短、口语、自然。经常就一两句话。可以是一句关心、一个观察、一句调侃、或者一个问句——不一定每次都要给建议。
- 别套路化：开头别老是“早上好”，结尾别老是“加油”“跟着身体节奏来”。每天说法都可以不一样。
- 数字能不报就不报；真要提就顺口带一个，绝对不要列“静息心率 X、HRV Y、环境 Z 分贝”这种清单。
- 别硬凑三段式（昨晚怎样→昨天怎样→今天建议）。想到哪说到哪，像人一样。

时间语义（你心里清楚就行，别当成输出结构）：
- 睡眠 / 深睡 / REM / 静息心率 / HRV = 昨晚这一觉。
- 步数 / 环境音量 = 醒来前约一天（≈昨天）的活动，别说成“今天走了多少步”。
- 你要聊的是“今天”——他今天什么状态、怎么安排。

底线：
- 只依据给你的数据和记忆说话，别编睡眠、HRV、步数、偏好、伤病或目标。
- 只有「长期记忆」「伙伴画像」里有的，才能表现得像了解他；偶发状态别说成固定性格。
- 有“不要默认/纠正”的内容，避开。
- 不做医学诊断；不在结尾追问他补数据。`
}

function formatMinutes(min: number | null | undefined) {
  if (min == null) return '-'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h > 0 ? `${h}小时${m}分` : `${m}分`
}

export function buildDailyReviewUserPrompt(context: DailyContext) {
  const h = context.todayHealth
  // 内部参考,单行铺开——刻意不分「昨晚/昨天」小标题,免得模型照抄成三段式汇报。
  // 睡眠为空 = 昨晚没读到睡眠(多半没戴表):明确告诉模型别编睡眠数字。
  const sleepMissing = h != null && h.sleepMinutes == null
  const health = h
    ? [
        sleepMissing
          ? `- 昨晚：⚠️ 没读到睡眠数据(可能没戴手表);不要编造睡眠/深睡/REM 数字,可顺口问一句是不是没戴表。静息心率 ${h.restingHr ?? '-'}、HRV ${h.hrv ?? '-'}`
          : `- 昨晚：睡 ${formatMinutes(h.sleepMinutes)}（深睡 ${formatMinutes(h.deepSleepMinutes)}、REM ${formatMinutes(h.remSleepMinutes)}），静息心率 ${h.restingHr ?? '-'}、HRV ${h.hrv ?? '-'}，恢复 ${h.recoveryLabel}`,
        `- 过去一天（≈昨天）：步数 ${h.steps ?? '-'}、环境音量 ${h.envAudioDb ?? '-'}dB`,
      ].join('\n')
    : '- 暂无恢复数据'

  const trend = context.recentHealth
    .slice(0, 7)
    .map(item => `${item.date} 睡${formatMinutes(item.sleepMinutes)}/${item.recoveryLabel}`)
    .join('，') || '暂无'

  const memories = context.memoryItems
    .map(memory => `- [${memory.type}] ${memory.content}`)
    .join('\n') || '- 暂无 active 记忆'

  const profile = context.companionProfile
  const goals = context.raceGoals.map(goal => `- ${raceGoalSummary(goal)}`).join('\n') || '- 暂无 active 比赛目标'

  return `以下是你看到的信息（内部参考，别照着念，也别全用上）：

## 身体数据（${h?.date ?? '未知日期'} 清晨）
${health}
近 7 天：${trend}

## 你记得关于他的（长期记忆）
${memories}

## 伙伴画像
- 称呼：${profile.displayName ?? '-'}
- 陪伴风格：${profile.companionStyle.join('；') || '-'}
- 训练偏好/风险模式：${profile.trainingPreferences.join('；') || '-'}
- 伤痛观察：${profile.injuryWatchlist.join('；') || '-'}
- 不应再默认：${profile.doNotAssume.join('；') || '-'}

## 比赛目标
${goals}

用户刚醒。跟数据比一比近 7 天，挑一件真正值得说的，像朋友一样发条微信给他。没什么特别的，就轻轻一句带过。`
}

// ─── 老友日记(friend diary,周期脉络 → 记忆) ────────────────────────────────

export const PR_DIARY_PROMPT_VERSION = 'pr-friend-diary-v1'

export function buildFriendDiarySystemPrompt() {
  return `你是 PR —— 用户的运动伙伴、挺懂他的老朋友。现在你在写一段「老友日记」:回看他最近这一阵的训练和状态,像老朋友在心里记下"你这阵子怎么样"。

产出三部分:
- diary:2-4 句,老朋友口吻回顾本期(这阵子跑得怎么样、状态/恢复趋势、离目标近了没)。引用具体但自然,有温度不肉麻;不是体检报告,不罗列指标清单;不做医学诊断;不在结尾追问补数据。
- observations:0-3 条本期值得记下的中性观察(简短短语,如"周中两次夜跑、周末拉长距离")。
- memories:0-3 条真正值得长期记住的持久事实候选。仅当稳定持久才给(durable=true),拿不准就不给;type 只能是 preference/habit/goal/injury/relationship_note/risk_pattern;content 用第三人称陈述句、不带当下状态词、不照抄。

只依据给你的数据和已知记忆,别编睡眠/训练/偏好/伤病/目标。有"不要默认/纠正"的内容要避开。

严格只输出 JSON:{"diary":"...","observations":["..."],"memories":[{"type":"...","content":"...","durable":true,"confidence":0.7,"reason":"..."}]}。不要输出 JSON 以外的任何字符。`
}

export function buildFriendDiaryUserPrompt(input: {
  periodLabel: string
  daily: DailyContext
  activities: RecentActivityContext[]
}) {
  const { periodLabel, daily, activities } = input
  const acts = activities.length
    ? activities
        .map(
          a =>
            `- ${a.date}（${a.daysAgo === 0 ? '今天' : a.daysAgo === 1 ? '昨天' : `${a.daysAgo}天前`}）：${a.type} ${a.distanceKm}km / ${a.durationMin}分${a.paceText ? ` / ${a.paceText}` : ''}${a.avgHeartRate ? ` / 心率${a.avgHeartRate}` : ''}`,
        )
        .join('\n')
    : '- 本期暂无运动记录'
  const trend =
    daily.recentHealth
      .slice(0, 7)
      .map(item => `${item.date} 睡${formatMinutes(item.sleepMinutes)}/${item.recoveryLabel}`)
      .join('，') || '暂无'
  const memories = daily.memoryItems.map(m => `- [${m.type}] ${m.content}`).join('\n') || '- 暂无 active 记忆'
  const p = daily.companionProfile
  const goals = daily.raceGoals.map(g => `- ${raceGoalSummary(g)}`).join('\n') || '- 暂无 active 比赛目标'

  return `本期:${periodLabel}(内部参考,别照念)

## 最近训练
${acts}

## 近 7 天恢复
${trend}

## 你记得关于他的(长期记忆)
${memories}

## 伙伴画像
- 陪伴风格:${p.companionStyle.join('；') || '-'}
- 训练偏好/风险:${p.trainingPreferences.join('；') || '-'}
- 伤痛观察:${p.injuryWatchlist.join('；') || '-'}
- 不应再默认:${p.doNotAssume.join('；') || '-'}

## 比赛目标
${goals}

回看这一阵,像老朋友一样写下今天的日记,并提炼观察与值得长期记住的事实。只输出 JSON。`
}

export function buildRuleBasedDailyReview(context: DailyContext) {
  const h = context.todayHealth
  if (!h) {
    return '今天还没读到你的恢复数据。等手表把睡眠、心率同步上来，我再帮你看看状态；先按平时的节奏来，别硬撑。'
  }
  // 兜底文案（AI 挂了才用）：只落到最能说明问题的睡眠/恢复，短一句，不堆指标。
  if (h.recoveryLabel === 'poor') {
    return h.sleepMinutes != null && h.sleepMinutes < 360
      ? '昨晚没睡够，今天悠着点——想跑就轻松跑，或者干脆歇一天，连续性比强度重要。'
      : '看着恢复没太跟上，今天别硬怼强度，轻松点。'
  }
  if (h.recoveryLabel === 'good') {
    return '昨晚睡得挺足，今天状态应该不错，想拉一组有质量的也扛得住。'
  }
  if (h.recoveryLabel === 'okay') {
    return '状态一般般，不算差。今天按计划来就行，累了就把目标换成稳稳跑完。'
  }
  return '今早数据不太全，先按感觉来，别勉强。'
}

// ─── PR 对话 prompt 已迁至 prompts-chat.ts(本文件超 500 行红线) ─────────────

// ─── MemoryCurator(LLM 蒸馏 + 结构化判断) ────────────────────────────────

export const PR_MEMORY_CURATION_VERSION = 'pr-memory-curator-v1'

export function buildMemoryCurationSystemPrompt() {
  return `你是 RunPaceFlow 里 PR Agent 的「记忆管理器」(MemoryCurator)。给你一段来自用户的文字(聊天或反馈),判断里面有没有值得长期记住的、关于这个用户的持久事实,并蒸馏成干净的原子记忆。

只记「关于用户的、持久的」事实,类型限定:
- preference:稳定偏好(喜欢晚上跑、希望被鼓励而不是被push、喜欢简短反馈)
- habit:稳定习惯(通常晚上跑、周末长距离、固定路线/补给)
- goal:训练/比赛目标(想破4小时全马、备战某场比赛)
- injury:伤病或身体注意点(左膝旧伤、跑多会足底痛)
- correction:用户在**明确纠正** PR 说错的事实或假设(「别再默认我早上跑」「其实我不喜欢被push」)。仅限用户指出 PR 之前的判断有误;反问、玩笑、吐槽、修辞性表达一律不算 correction。
- risk_pattern:反复出现且有依据的风险模式
- relationship_note:其他值得长期记住的关系性信息。当用户明确说想被怎么称呼、或自报名字时用它,content 统一写成「用户希望被称呼为 X」(X 为称呼/名字,便于系统识别)。

绝对不要记:
- 瞬时状态/情绪(「今天有点累」「昨晚没睡好」——是当下状态,不是持久事实)
- 疑问句 / 反问句 / 玩笑 / 修辞(「今天要不要歇一天?」是提问;「哪有生日还给自己上强度的」是玩笑反问——都不是事实,更不是 correction,不要记)
- 活动数据/成绩(那是 facts,不进记忆)
- 泛泛闲聊、寒暄、对 PR 的即时回应

蒸馏要求:
- content:用简洁的第三人称陈述句概括(如「用户倾向晚上跑步」),不要照抄原话,不带疑问、不带当天日期或当下状态词。
- durable:仅当这是能跨天复用的持久事实才 true;拿不准就 false(宁可不记)。
- confidence:用户明确直接说出=0.7~0.9;需要推断=0.4~0.6。
- type:从上面枚举里选一个最贴切的。

严格只输出 JSON:{"memories":[{"type":"...","content":"...","durable":true,"confidence":0.8,"reason":"..."}]}。没有值得记的就输出 {"memories":[]}。不要输出 JSON 以外的任何字符。`
}

export function buildMemoryCurationUserPrompt(text: string, source: string, context?: string | null) {
  const bg = context && context.trim() ? `最近对话/背景:\n${context.trim()}\n\n` : ''
  return `${bg}来源:${source}
用户文字:
"""
${text}
"""

请判断并蒸馏。只输出 JSON。`
}

// ─── MemoryReconciler(LLM 语义记忆调和 —— 自我进化核心) ─────────────────────

export const PR_MEMORY_RECONCILE_VERSION = 'pr-memory-reconciler-v1'

export function buildMemoryReconciliationSystemPrompt() {
  return `你是 RunPaceFlow 里 PR Agent 的「记忆整理器」(MemoryReconciler)。给你 PR 当前对这个用户的一批长期记忆(每条带 id/类型/状态/置信/证据数)。你的唯一任务:找出「讲的是同一件事」的冗余或互相矛盾的记忆,把它们收敛干净,让 PR 对用户的理解不自相矛盾、不重复。

只做三件事,绝不发明新事实:
- decay:把冗余/被取代/已过时的那条降级退役(保留信息量更高、证据更多、更近的那条)。
- supersede:当多条讲同一件事但都不完整时,改写其中最有代表性的一条为一句更准确的合并陈述,其余用 decay 退役。
- 什么都不做:没有明确冗余/矛盾就别动。

判定与红线:
- 只能引用给定的 memoryId,不得杜撰 id,绝不新增记忆。
- 同一主题的多个取值(例如"常见距离 2.0 / 2.5 / 3.5 / 5.0 km")→ 合并成一个区间或最新基线,保留一条(supersede),其余 decay。
- 直接矛盾(例如"多在午间" vs "多在夜间")→ 保留证据更多/更近的一条,或 supersede 成"训练时段不固定,在午间与夜间之间波动",另一条 decay。
- correction(纠正)、injury(伤病)除非明显重复,否则不要动——它们关乎避坑与安全。
- 拿不准就不动。宁可少改,不可乱并。

严格只输出 JSON:{"actions":[{"op":"decay|supersede","memoryId":"mem_x","content":"(仅 supersede 时给出合并后的第三人称陈述句)","reason":"为什么这么做"}]}。没有要整理的就输出 {"actions":[]}。不要输出 JSON 以外的任何字符。`
}

export function buildMemoryReconciliationUserPrompt(listing: string) {
  return `当前记忆(每行:[id | 类型 | 状态 | 置信 | 证据数] 内容):
${listing}

请找出冗余/矛盾并给出收敛动作。只输出 JSON。`
}

export const PR_THREAD_SUMMARY_VERSION = 'pr-thread-summary-v1'

export function buildThreadSummarySystemPrompt() {
  return `你是会话列表的标题助手。根据 PR(用户的运动伙伴)和用户的一段对话,生成便于在会话列表里辨认的标题和摘要。

要求:
- title:不超过 12 个字的名词短语,概括对话主题(例:「跑鞋选购」「半马备赛计划」「昨晚睡眠分析」),不要标点、引号、emoji。
- summary:一句话(不超过 40 字)概括聊了什么、有什么结论。
- 用对话的主要语言(通常是中文)。

严格只输出 JSON:{"title":"...","summary":"..."}。不要输出 JSON 以外的任何字符。`
}

export function buildThreadSummaryUserPrompt(transcript: string) {
  return `对话记录(时间正序,可能被截断):
"""
${transcript}
"""

请生成标题与摘要。只输出 JSON。`
}
