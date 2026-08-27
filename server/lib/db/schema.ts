import { sql } from 'drizzle-orm'
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * PR agent 自有库表集(24 表核心)。
 *
 * 从源仓 src/lib/db/activities-schema.ts 逐字复制,精简到抽离蓝图 design §2.1 定的 24 张:
 * 22 张 PR-owned + 2 张平台表(activities / splits)。
 * 已排除:activity_insights(属 dashboard 洞察)、user_profile / sync_logs / strava_events(仅内置 sync 才需)。
 * 保留跨界 FK(activityReviews / reviewAnnotations / subjectiveFeedback → activities)与全部 owned→owned FK。
 */

/**
 * 活动表 - 存储跑步活动的核心信息
 */
export const activities = sqliteTable('activities', {
  // 主键和基本信息
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  type: text('type').notNull(), // 'running' | 'cycling' | 'walking'
  source: text('source').notNull(), // 'nike' | 'strava' | 'garmin'
  sourceId: text('source_id').notNull(), // 原始平台的 ID

  // 时间信息
  startTime: integer('start_time', { mode: 'timestamp' }).notNull(),
  endTime: integer('end_time', { mode: 'timestamp' }).notNull(),
  duration: integer('duration').notNull(), // 秒

  // 距离和配速
  distance: real('distance').notNull(), // 米
  averagePace: real('average_pace'), // 秒/公里
  bestPace: real('best_pace'), // 秒/公里

  // 其他数据
  elevationGain: real('elevation_gain'), // 米
  averageHeartRate: integer('average_heart_rate'),
  maxHeartRate: integer('max_heart_rate'),
  calories: integer('calories'),

  // GPX 数据
  gpxData: text('gpx_data'), // 完整的 GPX XML
  routeCoordinates: text('route_coordinates'), // 预计算降采样坐标 JSON: [[lat,lng], ...]

  // 室内/户外标识
  isIndoor: integer('is_indoor', { mode: 'boolean' }).default(false), // true = 室内（跑步机等）

  // 赛事名称（同步时通过 zuicool.com 匹配获取）
  raceName: text('race_name'), // 如 "2025 北京马拉松"

  // 天气数据（同步时通过 Open-Meteo 获取）
  weatherData: text('weather_data'), // JSON: { temperature, humidity, windSpeed, weatherCode, description }

  // 时间戳
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * 分段数据表 - 存储每公里的详细数据
 */
export const splits = sqliteTable('splits', {
  id: text('id').primaryKey(),
  activityId: text('activity_id')
    .notNull()
    .references(() => activities.id, { onDelete: 'cascade' }),

  kilometer: integer('kilometer').notNull(), // 第几公里
  duration: integer('duration').notNull(), // 该公里用时（秒）
  pace: real('pace').notNull(), // 配速（秒/公里）
  distance: real('distance').notNull(), // 实际距离（米）
  elevationGain: real('elevation_gain'), // 海拔上升（米）
  averageHeartRate: integer('average_heart_rate'),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * PR 复盘表 - 保存面向用户的跑后/周/月/目标复盘输出
 */
export const activityReviews = sqliteTable('activity_reviews', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  activityId: text('activity_id').references(() => activities.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('generated'),
  featuresJson: text('features_json').notNull(),
  contextJson: text('context_json'),
  content: text('content').notNull(),
  model: text('model').notNull(),
  provider: text('provider'),
  inputHash: text('input_hash').notNull(),
  builderVersion: text('builder_version').notNull(),
  promptVersion: text('prompt_version').notNull(),
  supersededBy: text('superseded_by'),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(true),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * PR 图表批注表 - 保存复盘中可落在公里/时间点上的观察
 */
export const reviewAnnotations = sqliteTable('review_annotations', {
  id: text('id').primaryKey(),
  reviewId: text('review_id')
    .notNull()
    .references(() => activityReviews.id, { onDelete: 'cascade' }),
  activityId: text('activity_id')
    .notNull()
    .references(() => activities.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  atSeconds: integer('at_seconds'),
  kilometer: real('kilometer'),
  label: text('label').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * Agent 运行记录 - 第一阶段用于记录复盘生成的输入、状态和错误
 */
export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  trigger: text('trigger').notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  status: text('status').notNull().default('pending'),
  inputHash: text('input_hash'),
  builderVersion: text('builder_version').notNull(),
  model: text('model'),
  attempts: integer('attempts').notNull().default(0),
  lastStep: text('last_step'),
  lockedBy: text('locked_by'),
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
  nextRetryAt: integer('next_retry_at', { mode: 'timestamp' }),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const agentStateSnapshots = sqliteTable('agent_state_snapshots', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  step: text('step').notNull(),
  stateJson: text('state_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * 通知投递表 - 第一阶段先入队，dispatcher 后续接入微信测试号
 */
export const notificationDeliveries = sqliteTable('notification_deliveries', {
  id: text('id').primaryKey(),
  reviewId: text('review_id').references(() => activityReviews.id, { onDelete: 'set null' }),
  channel: text('channel').notNull(),
  recipient: text('recipient').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  payloadJson: text('payload_json'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  providerMessageId: text('provider_message_id'),
  errorCode: text('error_code'),
  lastError: text('last_error'),
  nextRetryAt: integer('next_retry_at', { mode: 'timestamp' }),
  lockedBy: text('locked_by'),
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * 主观反馈表 - 用户补充 RPE、疼痛、心情和备注后进入 PR 上下文
 */
export const subjectiveFeedback = sqliteTable('subjective_feedback', {
  id: text('id').primaryKey(),
  activityId: text('activity_id').references(() => activities.id, { onDelete: 'set null' }),
  mood: text('mood'),
  rpe: integer('rpe'),
  painJson: text('pain_json'),
  note: text('note'),
  source: text('source').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const memoryItems = sqliteTable('memory_items', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull().default('candidate'),
  content: text('content').notNull(),
  evidenceJson: text('evidence_json').notNull(),
  confidence: real('confidence').notNull().default(0),
  source: text('source').notNull(),
  // 同族记忆的稳定去重键(如 habit:time_of_day:running)。同一 dedupeKey 只保留一条,
  // 新信号取代旧内容,避免"午间/夜间"这类同族矛盾并存。为空则按内容去重。
  dedupeKey: text('dedupe_key'),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const memoryEvents = sqliteTable('memory_events', {
  id: text('id').primaryKey(),
  memoryId: text('memory_id').references(() => memoryItems.id, { onDelete: 'set null' }),
  runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  idempotencyKey: text('idempotency_key').notNull(),
  action: text('action').notNull(),
  status: text('status').notNull().default('applied'),
  patchJson: text('patch_json').notNull(),
  actor: text('actor').notNull(),
  expectedVersion: integer('expected_version'),
  resultingVersion: integer('resulting_version'),
  reason: text('reason'),
  conflictReason: text('conflict_reason'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const friendProfile = sqliteTable('friend_profile', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  companionStyleJson: text('companion_style_json'),
  activeGoalsJson: text('active_goals_json'),
  trainingPreferencesJson: text('training_preferences_json'),
  injuryWatchlistJson: text('injury_watchlist_json'),
  recentStateJson: text('recent_state_json'),
  doNotAssumeJson: text('do_not_assume_json'),
  // 常跑地点显式值 JSON: { lat, lng, label?, setAt }。属用户画像("我平时在哪跑步"),
  // 不是服务配置——由 app_settings 旧三键迁来,读写归 src/lib/pr/home-location.ts。
  homeLocationJson: text('home_location_json'),
  projectionVersion: integer('projection_version').notNull().default(1),
  sourceDiaryId: text('source_diary_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const friendDiaryEntries = sqliteTable('friend_diary_entries', {
  id: text('id').primaryKey(),
  periodStart: integer('period_start', { mode: 'timestamp' }).notNull(),
  periodEnd: integer('period_end', { mode: 'timestamp' }).notNull(),
  content: text('content').notNull(),
  observationsJson: text('observations_json'),
  memoryPatchesJson: text('memory_patches_json'),
  model: text('model').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const raceGoals = sqliteTable('race_goals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  raceDate: integer('race_date', { mode: 'timestamp' }).notNull(),
  distanceMeters: real('distance_meters').notNull(),
  targetType: text('target_type').notNull(),
  targetTimeSec: integer('target_time_sec'),
  priority: text('priority').notNull().default('primary'),
  status: text('status').notNull().default('active'),
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const healthDailyMetrics = sqliteTable('health_daily_metrics', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  sleepMinutes: integer('sleep_minutes'),
  deepSleepMinutes: integer('deep_sleep_minutes'),
  remSleepMinutes: integer('rem_sleep_minutes'),
  hrv: real('hrv'),
  restingHr: integer('resting_hr'),
  steps: integer('steps'),
  envAudioDb: real('env_audio_db'),
  source: text('source').notNull(),
  payloadJson: text('payload_json'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const lifeEvents = sqliteTable('life_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(),
  mediaUrl: text('media_url'),
  rawText: text('raw_text'),
  observationJson: text('observation_json'),
  model: text('model'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const knowledgeDocuments = sqliteTable('knowledge_documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  source: text('source'),
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const knowledgeChunks = sqliteTable('knowledge_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id')
    .notNull()
    .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const knowledgeEmbeddings = sqliteTable('knowledge_embeddings', {
  id: text('id').primaryKey(),
  chunkId: text('chunk_id')
    .notNull()
    .references(() => knowledgeChunks.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  vectorJson: text('vector_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const ragRetrievalLogs = sqliteTable('rag_retrieval_logs', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  query: text('query').notNull(),
  queryPlanJson: text('query_plan_json'),
  resultChunkIdsJson: text('result_chunk_ids_json').notNull(),
  scoresJson: text('scores_json'),
  selectedChunkIdsJson: text('selected_chunk_ids_json'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const ragEvalCases = sqliteTable('rag_eval_cases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  query: text('query').notNull(),
  expectedTopicsJson: text('expected_topics_json'),
  expectedChunkIdsJson: text('expected_chunk_ids_json'),
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const prFeedbackEvents = sqliteTable('pr_feedback_events', {
  id: text('id').primaryKey(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  eventType: text('event_type').notNull(),
  value: text('value'),
  note: text('note'),
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const prMetricEvents = sqliteTable('pr_metric_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  metricName: text('metric_name').notNull(),
  metricValue: real('metric_value').notNull(),
  dimensionsJson: text('dimensions_json'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const conversationThreads = sqliteTable('conversation_threads', {
  id: text('id').primaryKey(),
  title: text('title'),
  status: text('status').notNull().default('active'),
  summary: text('summary'),
  summaryMemoryRefsJson: text('summary_memory_refs_json'),
  lastMessageAt: integer('last_message_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const conversationMessages = sqliteTable('conversation_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => conversationThreads.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  memoryRefsJson: text('memory_refs_json'),
  contextJson: text('context_json'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * 数字分身投影(单例)。记忆/画像/健康之上的又一个投影层(与 friend_profile 同构):
 * payload_json 存整份 persona.v1(traits + renderManifest),owner 是 server/lib/pr/persona.ts。
 * 共库部署下宿主(admin)只 raw select 本表消费最终 JSON,不感知内部结构。
 * 设计:claudedocs/persona-avatar-design.md
 */
export const personaState = sqliteTable('persona_state', {
  id: text('id').primaryKey().default('singleton'),
  payloadJson: text('payload_json').notNull(),
  projectionVersion: integer('projection_version').notNull().default(1),
  builderVersion: text('builder_version').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/** 分身特征变更史:每次投影 diff 非空才写,供成长回放/审计。 */
export const personaEvents = sqliteTable('persona_events', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // trait_added | trait_changed | trait_removed
  traitKey: text('trait_key').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  sourceRef: text('source_ref'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// 导出类型
export type Activity = typeof activities.$inferSelect
export type NewActivity = typeof activities.$inferInsert

export type Split = typeof splits.$inferSelect
export type NewSplit = typeof splits.$inferInsert

export type ActivityReview = typeof activityReviews.$inferSelect
export type NewActivityReview = typeof activityReviews.$inferInsert

export type ReviewAnnotation = typeof reviewAnnotations.$inferSelect
export type NewReviewAnnotation = typeof reviewAnnotations.$inferInsert

export type AgentRun = typeof agentRuns.$inferSelect
export type NewAgentRun = typeof agentRuns.$inferInsert

export type AgentStateSnapshot = typeof agentStateSnapshots.$inferSelect
export type NewAgentStateSnapshot = typeof agentStateSnapshots.$inferInsert

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert

export type SubjectiveFeedback = typeof subjectiveFeedback.$inferSelect
export type NewSubjectiveFeedback = typeof subjectiveFeedback.$inferInsert

export type MemoryItem = typeof memoryItems.$inferSelect
export type NewMemoryItem = typeof memoryItems.$inferInsert

export type MemoryEvent = typeof memoryEvents.$inferSelect
export type NewMemoryEvent = typeof memoryEvents.$inferInsert

export type FriendProfile = typeof friendProfile.$inferSelect
export type NewFriendProfile = typeof friendProfile.$inferInsert

export type FriendDiaryEntry = typeof friendDiaryEntries.$inferSelect
export type NewFriendDiaryEntry = typeof friendDiaryEntries.$inferInsert

export type RaceGoal = typeof raceGoals.$inferSelect
export type NewRaceGoal = typeof raceGoals.$inferInsert

export type HealthDailyMetric = typeof healthDailyMetrics.$inferSelect
export type NewHealthDailyMetric = typeof healthDailyMetrics.$inferInsert

export type LifeEvent = typeof lifeEvents.$inferSelect
export type NewLifeEvent = typeof lifeEvents.$inferInsert

export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect
export type NewKnowledgeDocument = typeof knowledgeDocuments.$inferInsert

export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert

export type RagRetrievalLog = typeof ragRetrievalLogs.$inferSelect
export type NewRagRetrievalLog = typeof ragRetrievalLogs.$inferInsert

export type RagEvalCase = typeof ragEvalCases.$inferSelect
export type NewRagEvalCase = typeof ragEvalCases.$inferInsert

export type PrFeedbackEvent = typeof prFeedbackEvents.$inferSelect
export type NewPrFeedbackEvent = typeof prFeedbackEvents.$inferInsert

export type PrMetricEvent = typeof prMetricEvents.$inferSelect
export type NewPrMetricEvent = typeof prMetricEvents.$inferInsert

export type ConversationThread = typeof conversationThreads.$inferSelect
export type NewConversationThread = typeof conversationThreads.$inferInsert

export type ConversationMessage = typeof conversationMessages.$inferSelect
export type NewConversationMessage = typeof conversationMessages.$inferInsert

export type PersonaState = typeof personaState.$inferSelect
export type NewPersonaState = typeof personaState.$inferInsert

export type PersonaEvent = typeof personaEvents.$inferSelect
export type NewPersonaEvent = typeof personaEvents.$inferInsert
