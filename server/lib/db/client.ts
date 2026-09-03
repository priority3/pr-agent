import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

import * as schema from './schema'

/**
 * PR agent 数据库连接(单用户自部署,单一本地库)。
 *
 * Reason: 抽离后不再读 admin app_settings,库地址固定由 env 决定,不再有多租户/共享库包袱:
 * - 丢弃 30s TTL 配置缓存 + last-known-good 回退(那是 DB URL 来自 admin app_settings 才需要)。
 * - 丢弃 ACTIVITIES_DATABASE_URL / getRuntimeSettings 的 URL 解析杂耍。
 * DATABASE_URL 默认 file:./data/pr.db(本地 file 启用 WAL);可选 DATABASE_AUTH_TOKEN 供远程 libsql/Turso。
 * 保留 getActivitiesDb()/getActivitiesClient()/getDb 签名,搬迁来的 pr 代码零改动。
 */

function getDatabaseUrl(): string {
  return process.env.DATABASE_URL || 'file:./data/pr.db'
}

function getDatabaseAuthToken(): string | undefined {
  return process.env.DATABASE_AUTH_TOKEN || undefined
}

function ensureLocalDir(url: string) {
  if (!url.startsWith('file:')) return
  const filePath = url.replace(/^file:/, '')
  const dir = path.dirname(path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath))
  mkdirSync(dir, { recursive: true })
}

type DbInstance = ReturnType<typeof drizzle<typeof schema>>

let cachedDb: { db: DbInstance; signature: string } | undefined
let cachedClient: { client: Client; signature: string } | undefined

/**
 * 建表 + 索引(首次访问时惰性调用、幂等)。
 *
 * 从源仓 activities-client.ts 移植,精简到 design §2.1 的 24 张表:
 * 已删掉 activity_insights / sync_logs / user_profile / strava_events 的 DDL 与索引。
 * 老库补列的 ALTER 迁移块也一并去掉——新建库的 CREATE TABLE 已含全部列,无需补丁。
 */
export async function ensureActivitiesSchema(client: Client) {
  await client.execute('PRAGMA foreign_keys = ON;')

  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS activities (
        id text PRIMARY KEY NOT NULL,
        title text NOT NULL,
        type text NOT NULL,
        source text NOT NULL,
        source_id text NOT NULL,
        start_time integer NOT NULL,
        end_time integer NOT NULL,
        duration integer NOT NULL,
        distance real NOT NULL,
        average_pace real,
        best_pace real,
        elevation_gain real,
        average_heart_rate integer,
        max_heart_rate integer,
        calories integer,
        gpx_data text,
        route_coordinates text,
        is_indoor integer DEFAULT false,
        race_name text,
        weather_data text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS splits (
        id text PRIMARY KEY NOT NULL,
        activity_id text NOT NULL,
        kilometer integer NOT NULL,
        duration integer NOT NULL,
        pace real NOT NULL,
        distance real NOT NULL,
        elevation_gain real,
        average_heart_rate integer,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON UPDATE no action ON DELETE cascade
      )`,
      `CREATE TABLE IF NOT EXISTS agent_runs (
        id text PRIMARY KEY NOT NULL,
        idempotency_key text NOT NULL,
        trigger text NOT NULL,
        subject_type text,
        subject_id text,
        status text NOT NULL DEFAULT 'pending',
        input_hash text,
        builder_version text NOT NULL,
        model text,
        attempts integer NOT NULL DEFAULT 0,
        last_step text,
        locked_by text,
        locked_until integer,
        next_retry_at integer,
        error_code text,
        error_message text,
        started_at integer,
        completed_at integer,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS activity_reviews (
        id text PRIMARY KEY NOT NULL,
        run_id text,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        activity_id text,
        kind text NOT NULL,
        status text NOT NULL DEFAULT 'generated',
        features_json text NOT NULL,
        context_json text,
        content text NOT NULL,
        model text NOT NULL,
        provider text,
        input_hash text NOT NULL,
        builder_version text NOT NULL,
        prompt_version text NOT NULL,
        superseded_by text,
        is_current integer NOT NULL DEFAULT 1,
        error_message text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON UPDATE no action ON DELETE set null,
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON UPDATE no action ON DELETE set null
      )`,
      `CREATE TABLE IF NOT EXISTS review_annotations (
        id text PRIMARY KEY NOT NULL,
        review_id text NOT NULL,
        activity_id text NOT NULL,
        type text NOT NULL,
        at_seconds integer,
        kilometer real,
        label text NOT NULL,
        content text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (review_id) REFERENCES activity_reviews(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON UPDATE no action ON DELETE cascade
      )`,
      `CREATE TABLE IF NOT EXISTS agent_state_snapshots (
        id text PRIMARY KEY NOT NULL,
        run_id text NOT NULL,
        step text NOT NULL,
        state_json text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON UPDATE no action ON DELETE cascade
      )`,
      `CREATE TABLE IF NOT EXISTS notification_deliveries (
        id text PRIMARY KEY NOT NULL,
        review_id text,
        channel text NOT NULL,
        recipient text NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        payload_json text,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        provider_message_id text,
        error_code text,
        last_error text,
        next_retry_at integer,
        locked_by text,
        locked_until integer,
        sent_at integer,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (review_id) REFERENCES activity_reviews(id) ON UPDATE no action ON DELETE set null
      )`,
      `CREATE TABLE IF NOT EXISTS subjective_feedback (
        id text PRIMARY KEY NOT NULL,
        activity_id text,
        mood text,
        rpe integer,
        pain_json text,
        note text,
        source text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (activity_id) REFERENCES activities(id) ON UPDATE no action ON DELETE set null
      )`,
      `CREATE TABLE IF NOT EXISTS memory_items (
        id text PRIMARY KEY NOT NULL,
        type text NOT NULL,
        status text NOT NULL DEFAULT 'candidate',
        content text NOT NULL,
        evidence_json text NOT NULL,
        confidence real NOT NULL DEFAULT 0,
        source text NOT NULL,
        dedupe_key text,
        first_seen_at integer DEFAULT (unixepoch()) NOT NULL,
        last_seen_at integer DEFAULT (unixepoch()) NOT NULL,
        expires_at integer,
        version integer NOT NULL DEFAULT 1,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS memory_events (
        id text PRIMARY KEY NOT NULL,
        memory_id text,
        run_id text,
        idempotency_key text NOT NULL,
        action text NOT NULL,
        status text NOT NULL DEFAULT 'applied',
        patch_json text NOT NULL,
        actor text NOT NULL,
        expected_version integer,
        resulting_version integer,
        reason text,
        conflict_reason text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON UPDATE no action ON DELETE set null,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON UPDATE no action ON DELETE set null
      )`,
      `CREATE TABLE IF NOT EXISTS friend_profile (
        id text PRIMARY KEY NOT NULL,
        display_name text,
        companion_style_json text,
        active_goals_json text,
        training_preferences_json text,
        injury_watchlist_json text,
        recent_state_json text,
        do_not_assume_json text,
        home_location_json text,
        projection_version integer NOT NULL DEFAULT 1,
        source_diary_id text,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS friend_diary_entries (
        id text PRIMARY KEY NOT NULL,
        period_start integer NOT NULL,
        period_end integer NOT NULL,
        content text NOT NULL,
        observations_json text,
        memory_patches_json text,
        model text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS race_goals (
        id text PRIMARY KEY NOT NULL,
        name text NOT NULL,
        race_date integer NOT NULL,
        distance_meters real NOT NULL,
        target_type text NOT NULL,
        target_time_sec integer,
        priority text NOT NULL DEFAULT 'primary',
        status text NOT NULL DEFAULT 'active',
        notes text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS health_daily_metrics (
        id text PRIMARY KEY NOT NULL,
        date text NOT NULL,
        sleep_minutes integer,
        deep_sleep_minutes integer,
        rem_sleep_minutes integer,
        hrv real,
        resting_hr integer,
        steps integer,
        env_audio_db real,
        source text NOT NULL,
        payload_json text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS life_events (
        id text PRIMARY KEY NOT NULL,
        type text NOT NULL,
        occurred_at integer NOT NULL,
        media_url text,
        raw_text text,
        observation_json text,
        model text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS knowledge_documents (
        id text PRIMARY KEY NOT NULL,
        title text NOT NULL,
        source text,
        metadata_json text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id text PRIMARY KEY NOT NULL,
        document_id text NOT NULL,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        metadata_json text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON UPDATE no action ON DELETE cascade
      )`,
      `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        id text PRIMARY KEY NOT NULL,
        chunk_id text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        vector_json text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES knowledge_chunks(id) ON UPDATE no action ON DELETE cascade
      )`,
      `CREATE TABLE IF NOT EXISTS rag_retrieval_logs (
        id text PRIMARY KEY NOT NULL,
        run_id text,
        query text NOT NULL,
        query_plan_json text,
        result_chunk_ids_json text NOT NULL,
        scores_json text,
        selected_chunk_ids_json text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON UPDATE no action ON DELETE set null
      )`,
      `CREATE TABLE IF NOT EXISTS rag_eval_cases (
        id text PRIMARY KEY NOT NULL,
        name text NOT NULL,
        query text NOT NULL,
        expected_topics_json text,
        expected_chunk_ids_json text,
        notes text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pr_feedback_events (
        id text PRIMARY KEY NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        event_type text NOT NULL,
        value text,
        note text,
        metadata_json text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pr_metric_events (
        id text PRIMARY KEY NOT NULL,
        run_id text,
        metric_name text NOT NULL,
        metric_value real NOT NULL,
        dimensions_json text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON UPDATE no action ON DELETE set null
      )`,
      `CREATE TABLE IF NOT EXISTS conversation_threads (
        id text PRIMARY KEY NOT NULL,
        title text,
        status text NOT NULL DEFAULT 'active',
        summary text,
        summary_memory_refs_json text,
        last_message_at integer,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS conversation_messages (
        id text PRIMARY KEY NOT NULL,
        thread_id text NOT NULL,
        run_id text,
        role text NOT NULL,
        content text NOT NULL,
        memory_refs_json text,
        context_json text,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES conversation_threads(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON UPDATE no action ON DELETE set null
      )`,
      `CREATE TABLE IF NOT EXISTS persona_state (
        id text PRIMARY KEY NOT NULL DEFAULT 'singleton',
        payload_json text NOT NULL,
        projection_version integer NOT NULL DEFAULT 1,
        builder_version text NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS runtime_settings (
        key text PRIMARY KEY NOT NULL,
        value_encrypted text NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      // 定时任务的**运行时覆盖**。job 的 id/name/默认 cron 仍在 scheduler.ts 的 DEFAULT_JOBS
      // 里(代码是唯一 job 清单),这张表只存用户改过的 cron 与开关 —— 所以新增/删除 job
      // 不需要迁移,表里的孤儿行会被直接忽略。
      `CREATE TABLE IF NOT EXISTS scheduler_jobs (
        id text PRIMARY KEY NOT NULL,
        cron_expression text,
        enabled integer DEFAULT 1 NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      // 每次执行落一行,按 job 只保留最近 N 条(见 scheduler.ts 的 recordJobRun)。
      `CREATE TABLE IF NOT EXISTS scheduler_job_runs (
        id integer PRIMARY KEY AUTOINCREMENT,
        job_id text NOT NULL,
        started_at integer NOT NULL,
        duration_ms integer,
        ok integer NOT NULL,
        message text
      )`,
      `CREATE INDEX IF NOT EXISTS idx_job_runs_job_started
        ON scheduler_job_runs (job_id, started_at DESC)`,
      `CREATE TABLE IF NOT EXISTS persona_events (
        id text PRIMARY KEY NOT NULL,
        kind text NOT NULL,
        trait_key text NOT NULL,
        before_json text,
        after_json text,
        source_ref text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      // H5 对话的一次性入口链接与它兑换出的设备令牌。两张表都只存 sha256(token),
      // 校验时哈希入参再比对 —— 见 server/lib/pr/chat-access.ts。
      `CREATE TABLE IF NOT EXISTS pr_chat_invites (
        id text PRIMARY KEY NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at integer NOT NULL,
        used_at integer,
        device_id text,
        device_token_enc text,
        note text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pr_chat_devices (
        id text PRIMARY KEY NOT NULL,
        token_hash text NOT NULL UNIQUE,
        label text,
        invite_id text,
        expires_at integer NOT NULL,
        last_used_at integer,
        revoked_at integer,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
    ],
    'write',
  )

  await client.execute('CREATE INDEX IF NOT EXISTS idx_activities_source_id ON activities(source, source_id)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_activities_source_start_time ON activities(source, start_time)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_splits_activity_id ON splits(activity_id)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_activity_reviews_activity_id ON activity_reviews(activity_id)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_activity_reviews_kind_created_at ON activity_reviews(kind, created_at)')
  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_reviews_idempotency ON activity_reviews(kind, subject_type, subject_id, input_hash)',
  )
  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_reviews_current_subject ON activity_reviews(kind, subject_type, subject_id) WHERE is_current = 1',
  )
  await client.execute('CREATE INDEX IF NOT EXISTS idx_review_annotations_review_id ON review_annotations(review_id)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_agent_runs_trigger_status_created_at ON agent_runs(trigger, status, created_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_agent_runs_subject ON agent_runs(subject_type, subject_id)')
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_idempotency ON agent_runs(idempotency_key)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_agent_state_snapshots_run_id_created_at ON agent_state_snapshots(run_id, created_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status_created_at ON notification_deliveries(status, created_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_review_id ON notification_deliveries(review_id)')
  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_unique_target ON notification_deliveries(review_id, channel, recipient)',
  )
  await client.execute('CREATE INDEX IF NOT EXISTS idx_subjective_feedback_activity_id ON subjective_feedback(activity_id, created_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_memory_items_type_status ON memory_items(type, status)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_memory_items_last_seen_at ON memory_items(last_seen_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_memory_items_dedupe_key ON memory_items(dedupe_key)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id_created_at ON memory_events(memory_id, created_at)')
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_idempotency ON memory_events(idempotency_key)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_friend_diary_entries_period ON friend_diary_entries(period_start, period_end)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_race_goals_status_race_date ON race_goals(status, race_date)')
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_health_daily_metrics_date_source ON health_daily_metrics(date, source)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_life_events_type_occurred_at ON life_events(type, occurred_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_id ON knowledge_chunks(document_id)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_rag_retrieval_logs_run_id ON rag_retrieval_logs(run_id)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_pr_feedback_events_target ON pr_feedback_events(target_type, target_id, created_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_pr_metric_events_name_created_at ON pr_metric_events(metric_name, created_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_id_created_at ON conversation_messages(thread_id, created_at)')
  await client.execute('CREATE INDEX IF NOT EXISTS idx_persona_events_created_at ON persona_events(created_at)')
}

export async function getActivitiesClient(): Promise<Client> {
  const url = getDatabaseUrl()
  const authToken = getDatabaseAuthToken()
  const signature = `${url}\n${authToken ?? ''}`

  if (!cachedClient || cachedClient.signature !== signature) {
    ensureLocalDir(url)
    cachedClient = {
      client: createClient({ url, authToken }),
      signature,
    }
  }

  return cachedClient.client
}

export async function getActivitiesDb() {
  const url = getDatabaseUrl()
  const authToken = getDatabaseAuthToken()
  const signature = `${url}\n${authToken ?? ''}`

  if (!cachedDb || cachedDb.signature !== signature) {
    const client = await getActivitiesClient()
    // Reason: WAL 模式减少 SQLITE_BUSY 锁错误。仅对本地 file: 库执行(远程 libsql 不需要也不支持)。
    if (url.startsWith('file:')) {
      try {
        await client.execute('PRAGMA foreign_keys = ON;')
        await client.execute('PRAGMA journal_mode=WAL;')
        await client.execute('PRAGMA busy_timeout=5000;')
      } catch {
        // 忽略 PRAGMA 失败,不阻断连接
      }
    }
    await ensureActivitiesSchema(client)
    cachedDb = { db: drizzle(client, { schema }), signature }
  }

  return cachedDb.db
}

// 兼容别名:搬迁来的 processor.ts/service.ts 用 getDb()
export const getDb = getActivitiesDb
