import { getActivitiesClient } from '@/lib/db/client'

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0
  return Number((numerator / denominator).toFixed(4))
}

export async function getPrMetrics(days = 30) {
  const db = await getActivitiesClient()
  const start = Math.floor((Date.now() - days * 86_400_000) / 1000)
  const [
    runs,
    reviews,
    notifications,
    memories,
    feedbackEvents,
    feedback,
    life,
    health,
    goals,
  ] = await Promise.all([
    db.execute({
      sql: `SELECT status, COUNT(*) as count FROM agent_runs WHERE created_at >= ? GROUP BY status`,
      args: [start],
    }),
    db.execute({
      sql: `SELECT kind, COUNT(*) as count FROM activity_reviews WHERE created_at >= ? GROUP BY kind`,
      args: [start],
    }),
    db.execute({
      sql: `SELECT status, COUNT(*) as count FROM notification_deliveries WHERE created_at >= ? GROUP BY status`,
      args: [start],
    }),
    db.execute({
      sql: `SELECT status, COUNT(*) as count FROM memory_items GROUP BY status`,
      args: [],
    }),
    db.execute({
      sql: `SELECT event_type, COUNT(*) as count FROM pr_feedback_events WHERE created_at >= ? GROUP BY event_type`,
      args: [start],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM subjective_feedback WHERE created_at >= ?`,
      args: [start],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM life_events WHERE created_at >= ?`,
      args: [start],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM health_daily_metrics WHERE created_at >= ?`,
      args: [start],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM race_goals WHERE status = 'active'`,
      args: [],
    }),
  ])

  const runCounts = Object.fromEntries(runs.rows.map(row => [String(row.status), numberValue(row.count)]))
  const reviewCounts = Object.fromEntries(reviews.rows.map(row => [String(row.kind), numberValue(row.count)]))
  const notificationCounts = Object.fromEntries(notifications.rows.map(row => [String(row.status), numberValue(row.count)]))
  const memoryCounts = Object.fromEntries(memories.rows.map(row => [String(row.status), numberValue(row.count)]))
  const feedbackEventCounts = Object.fromEntries(feedbackEvents.rows.map(row => [String(row.event_type), numberValue(row.count)]))
  const totalRuns = Object.values(runCounts).reduce((sum, count) => sum + count, 0)
  const sentNotifications = numberValue(notificationCounts.sent)
  const failedNotifications = numberValue(notificationCounts.failed)
  const pendingNotifications = numberValue(notificationCounts.pending)
  const totalNotifications = sentNotifications + failedNotifications + pendingNotifications
  const totalMemories = Object.values(memoryCounts).reduce((sum, count) => sum + count, 0)

  return {
    period: {
      days,
      start: new Date(start * 1000).toISOString(),
      end: new Date().toISOString(),
    },
    agentRuns: {
      total: totalRuns,
      byStatus: runCounts,
      successRate: rate(numberValue(runCounts.succeeded), totalRuns),
    },
    reviews: {
      total: Object.values(reviewCounts).reduce((sum, count) => sum + count, 0),
      byKind: reviewCounts,
    },
    notifications: {
      total: totalNotifications,
      byStatus: notificationCounts,
      sentRate: rate(sentNotifications, totalNotifications),
    },
    memories: {
      total: totalMemories,
      byStatus: memoryCounts,
      activeRate: rate(numberValue(memoryCounts.active), totalMemories),
    },
    feedbackEvents: {
      total: Object.values(feedbackEventCounts).reduce((sum, count) => sum + count, 0),
      byType: feedbackEventCounts,
    },
    facts: {
      subjectiveFeedback: numberValue(feedback.rows[0]?.count),
      lifeEvents: numberValue(life.rows[0]?.count),
      healthDailyMetrics: numberValue(health.rows[0]?.count),
      activeRaceGoals: numberValue(goals.rows[0]?.count),
    },
  }
}

export async function getPrFlywheel(days = 30) {
  const metrics = await getPrMetrics(days)
  const factGrowth =
    metrics.facts.subjectiveFeedback +
    metrics.facts.lifeEvents +
    metrics.facts.healthDailyMetrics +
    metrics.facts.activeRaceGoals
  const reviewTotal = metrics.reviews.total
  const memoryTotal = metrics.memories.total
  const feedbackEventTotal = metrics.feedbackEvents.total

  return {
    period: metrics.period,
    factGrowth,
    feedbackRate: rate(metrics.facts.subjectiveFeedback + feedbackEventTotal, reviewTotal),
    // 确认率 = 用户面板确认次数 / 记忆总数。不再用 active 数兜底(那会把"自动晋升的 active"
    // 误当成"用户确认",高估确认率)。无确认事件时如实为 0。
    memoryConfirmationRate: rate(metrics.feedbackEvents.byType.memory_confirm ?? 0, memoryTotal),
    memoryCorrectionRate: rate((metrics.feedbackEvents.byType.memory_archive ?? 0) + (metrics.feedbackEvents.byType.correction ?? 0), memoryTotal),
    contextHitRate: rate((metrics.facts.healthDailyMetrics > 0 ? 1 : 0) + (metrics.facts.activeRaceGoals > 0 ? 1 : 0), 2),
    ragUsefulRate: 0,
    notificationEngagementRate: metrics.notifications.sentRate,
    reviewRegenerationRate: rate(metrics.feedbackEvents.byType.regenerate ?? 0, reviewTotal),
    source: {
      metrics,
      notes: ['RAG/usefulness/event-level feedback tables are not wired yet; rates use current durable tables only.'],
    },
  }
}
