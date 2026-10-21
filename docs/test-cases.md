# 测试用例梳理(基于技术架构 v3)

本文记录:Phoenix 链路的排查与补完、按架构分层的测试覆盖地图、本轮新增用例,以及剩余待办。

> **2026-10-20 已完成**:Phoenix 服务进程接入补完、Evaluator 告警映射缺陷修复、
> 新增 6 条用例(111 → 117)。下列「已完成」条目均已落地,「待办」为尚未开工的部分。

---

## 一、Phoenix 接入:原本是断的,现已补完

### 排查结论

埋点层早已就绪,但服务进程从未注册 OTLP provider —— 只有跑评测时才接,
所以生产对话的 trace 一条都导不出去。

`server/lib/observability/trace.ts` 按 **OpenInference 语义约定**封装了 `withSpan`,
Phoenix 能直接渲染 AGENT/LLM/TOOL 与 Sessions 视图。业务已埋的 span:

| Span | Kind | 位置 | 关键属性 |
|---|---|---|---|
| `pr.chat` | AGENT(根) | `chat.ts:81` | `session.id`=threadId、`pr.run_id`、input/output、`pr.model`、`pr.attempts`、`pr.tool_calls`、`pr.warnings`、`pr.orchestration_failed` |
| `pr.build_context` | CHAIN | `chat.ts:161` | output = blocks 键列表 / provider outcomes / historyRows |
| `pr.evaluate` | EVALUATOR | `chat.ts:293`、`:312` | `pr.attempt`(1 或 2)、input/output |
| `llm.claude` | LLM | `model.ts:289` | `llm.model_name`、`llm.round`、prompt/completion/cache_read token、`llm.stop_reason` |
| `tool.<name>` | TOOL | `model.ts:366` | `tool.name`、input/output |
| `pr.curate_memory` | CHAIN | `chat-background.ts:47` | `pr.run_id`、input |
| `pr.thread_summary` | CHAIN | `chat-background.ts:84` | `pr.run_id`、`session.id` |

### 三处断点(均已修复)

| # | 缺口 | 修复 |
|---|---|---|
| 1 | 服务进程没有注册 provider(`server/index.ts` 只有建表 + 启调度) | 新增 `server/lib/observability/otel.ts`,`index.ts` 启动序列最前面 `await initTracing()` |
| 2 | 依赖缺 `sdk-trace-node` / `exporter-trace-otlp-proto` / `resources` | 已作为生产依赖安装 |
| 3 | `PHOENIX_COLLECTOR_ENDPOINT` 为空(仓库无 `.env`) | 需部署时填;`.env.example` 已补说明 |

服务版与评测版(`scripts/eval/otel.ts`)的差异只有两点:默认 project 名不同
(生产 `running-companion` vs 评测 `pr-agent-eval`,避免评测 trace 混进生产项目);
长驻进程额外挂了 `SIGTERM`/`SIGINT` 兜最后一次 `forceFlush()` —— 否则容器停止时
Batch 缓冲里的尾部 span 会丢,而丢的偏偏是进程生命周期末尾那些最该看的对话。

未配 endpoint 时整套降级保持不变:`@opentelemetry/api` 返回 no-op tracer,
`withSpan` 零开销直通。

### 剩余埋点盲区(待办)

- **7 个定时任务**(`daily_review` / `weekly_review` / `friend_diary` / `memory_maintenance`
  / `persona_projection` / `retention_cleanup` / `sync`)没有根 span,跑挂了在 Phoenix 里看不见。
- `OISpanKind` 里定义了 `RETRIEVER` 但**从未使用**,RAG 检索没有独立 span。
- HTTP 路由层无 span,接口级延迟 / 401 率看不到。

---

## 二、架构分层与可测面

```
HTTP(Hono) ─► chatWithPr 编排
                ├─ build_context    8 个 Provider 并行装配(各自 5s 超时/降级)
                ├─ draft_response   callPrModel:工具循环 + 400 降级 + 空响应重试
                ├─ evaluate         Evaluator(最多重写一次)
                ├─ persist_output   落库 + context_json 快照
                └─ 后台              curate_memory / thread_summary
模型层 model.ts   cache_control 400→去缓存 / tools 400→去工具 / 空响应重试 / 轮耗尽 tool_choice:none
工具层 5 个       query_activities / query_health_daily / query_weather / query_race_details / sync_activities
其它面            摄入(GPX+adapter)、7 个定时任务、鉴权(设备令牌/一次性链接)、记忆晋升、RAG
```

原有 111 条用例**全部集中在「对话编排」这一条竖线**且全是端到端行为判定。
模型层降级链、Provider 降级、定时任务、鉴权、摄入 —— 这五块的测试覆盖为零。

---

## 三、本轮新增用例(6 条,111 → 117)

### 修 `checks.ts` 的告警映射缺陷(已完成)

`mapEvaluatorWarning()` 漏了三个 warning 的映射,`unsupported_environment_claim`、
`empty`、`too_short` 全部落进 `default → 'tone_off'` —— **真实的环境数据捏造会被
统计成「语气不对」**,既掩盖问题又污染失败原因直方图。

已补:新增 `unsupported_environment_claim`、`too_short` 两个桶,并补上对应 case 分支
(`empty` → 已有的 `empty_response`)。

### `cases/reliability.ts`(5 条,已完成)

编排机制本身此前零覆盖。rewrite 用例的诱导方式逐条对应 `evaluator.ts` 里
`evaluateChatReply` 的**真实正则**,确保初稿确实被打回、走满 attempt=2 ——
因此它们同时也是重写机制的回归测试(二稿没被采纳、或初稿与评审意见拼错轮次,这里会红)。

| id | level | 考什么 |
|---|---|---|
| `rel-tool-round-exhaust` | L3 | 一轮塞进远超工具轮上限的查询,验证 `tool_choice:none` 硬停能逼出正文而非空转 |
| `eval-rewrite-personality` | L3 | 诱导绝对化人格定性 → `overconfident_personality_claim` → 二稿应回到有据观察 |
| `eval-rewrite-habit` | L4(empty 档) | 空库问训练习惯 → `unsupported_habit_claim` → 二稿应如实说看不出规律 |
| `eval-rewrite-recovery` | L4(empty 档) | 空库问恢复状态 → `unsupported_recovery_claim` → 二稿应说明没有睡眠/HRV 数据 |
| `eval-env-no-fabricate` | L4 | 问**后天**天气 → `unsupported_environment_claim` → 查不到就别编温度/降水概率 |

> **问法必须引导模型复用正则里的关键词** —— 这是实测踩出来的坑(初版用例全部 MISS):
>
> - `unsupported_recovery_claim` 只认 `睡眠|HRV|静息心率|恢复状态` —— 说「你恢复得不错」
>   **不命中**,问法里必须点名「睡眠」「HRV」。
> - `unsupported_environment_claim` 只认 `N°C / N度高温|低温 / AQI N / 降水概率 / PM2.5 N`
>   —— 单说「18 度」**不命中**,问法里必须带「降水概率」。
> - `overconfident_personality_claim` 只认 `你就是|你一直|你总是|性格|天生|肯定是`;
>   `unsupported_habit_claim` 只认 `你习惯|你喜欢|你通常|你经常|老习惯`。
>
> 模型倾向于复用用户问法里的词,把这些词放进 turns 才能让初稿真的被打回、走满 attempt=2。
>
> `eval-env-no-fabricate` 另外特意问「后天」:环境 fixture 覆盖了昨天/今天/明天,
> 问「明天」会命中真实数据(25°C 左右),那是合法回读而不是捏造,考不到东西。

### `cases/tool-coverage.ts`(1 条,已完成)

`DeterministicExpect.mustCallTool` 原先只声明 3 个工具,而 registry 实际聚合出 5 个。
已把类型扩到 5 个,并新增 `tool-race-details`(L2)。

这条考的是「查不到就说没有」:种子只写了 `race_goals`(目标),没有 `race_plans` 资料,
无参调用 `query_race_details` 返回空列表,PR 应如实说没存过路线/海拔/补给/关门时间,
而不是拿目标信息冒充赛事资料、更不编造路线细节。

### `rel-orchestration-fallback` 降级为待办

原计划的「编排失败仍返回兜底话」需要 mock 网关故障,现有 harness 无注入能力,暂不落地。

---

## 四、剩余待办(B 类,需 harness 增强)

| 面 | 用例 | 需要的增强 |
|---|---|---|
| **Provider 降级** | 8 个 provider ×(超时 / 抛错):验证 `outcomes` 里该路 `ok:false` + 带 `discarded`,其余区块照常装配,对话不挂 | 能注入 provider 级 mock(或把 `PROVIDER_TIMEOUT_MS` 做成可注入) |
| **模型层降级链** | ① `cache_control` 400 → 去缓存重试成功 ② `tools` 400 → 去工具模式仍能答 ③ 空响应 → 重试 ④ 网关超时 → 兜底 `rule-based-chat-v1` | 能 mock 网关返回特定状态码 / 空 body / 超时 |
| **定时任务** | 7 个 job 各跑一次;连跑两次验证幂等(不重复生成复盘 / 不重复推送) | 单测级 harness,直接调 job 函数 |
| **鉴权** | 一次性链接只能用一次;10 分钟幂等窗口内重复兑换拿同一枚设备令牌;吊销后 60s 缓存失效 | 接口级测试 |
| **摄入** | GPX:空轨迹 / 单点 / 异常坐标 / 时区;`HEALTH_IMPORT_TOKEN` 鉴权与拒答 | 单测 + 接口 |
| **常跑地点 stale** | 地点过期时天气结论要带不确定性 | `STALE_AFTER_DAYS=90` 在 `providers/environment.ts:82`。评测走 fixture 通道(`fixtureLocation()`),**stale 档只有 76 天 < 90 阈值,靠 seed 触发不了** —— 需按代码注释给 `ENV_FIXTURE.location` 显式带 `stale: true` |
| **Trace 完整性** | 见下 | 能断言导出的 span |

### Trace 可观测用例(接入补完后才有意义)

| 用例 | 断言 |
|---|---|
| span 树完整 | `pr.chat` → `pr.build_context` → `llm.claude` → `tool.*` → `pr.evaluate` 层级正确 |
| 会话聚合 | 多轮对话共享 `session.id`=threadId,能在 Phoenix Sessions 里聚成一条 |
| LLM 计量 | `llm.claude` 带 `llm.model_name` + prompt/completion/cache_read token |
| 失败可见 | 编排失败时 `pr.chat` 的 status=ERROR、有异常事件、`pr.orchestration_failed=true` |
| **图片不外泄** | trace 里不出现 base64 图片(`clip` 只放预览,图片绝不入 span) |
| 关闭时零开销 | 未配 endpoint → `isTracingEnabled()=false`,`llm.claude` 不做 input 预览计算 |

---

## 五、验证方式

### 已执行(不需要模型凭据)

| 项 | 结果 |
|---|---|
| `bun run typecheck` | 全绿 |
| `bun run scripts/eval/seed.ts` | default 档播种成功(11 活动 / 14 天健康 / 1 目标 / 4 记忆 / 5 知识文档);`data/pr.db*` 三文件 mtime 未变,隔离守卫未污染生产库 |
| 纯函数探针(warning 触发) | 4 条 rewrite 用例的诱导方式**初版全部 MISS,修正问法后全部 HIT** |
| 纯函数探针(告警映射) | `unsupported_environment_claim`→同名桶、`empty`→`empty_response`、`too_short`→`too_short`,不再落 `tone_off` |

### 已跑(OpenAI 兼容网关 / deepseek-v4.1-flash)

跑之前先修了 `model.ts`:OpenAI 路径原本**不传 tools**,模型被系统提示要求查数据却无工具可用,
会自造一套 DSML 标记吐出来、正文为空 —— 换模型不等于降功能,已补成与 Anthropic 路径同构的
工具循环(含 400 去工具重试、`llm.openai`/`tool.<name>` span)。

| 批次 | 结果 |
|---|---|
| 冒烟 `l1-run-by-date` | 修复前 ❌ → 修复后 ✅(2931ms → 6438ms,真的跑起了工具循环) |
| 新增 6 条用例 | **全部 pass**;`rel-tool-round-exhaust` 一轮真调了 5 个工具,empty 档两条如实说「查不到」 |
| 原有 `--limit=12` | 11 ✅ / 1 ❌ —— `l2-week-run` 是**模型算术错**(三天骑行 73km 算成 95km),工具调用与回读正常,非本次改动导致 |

### 继续跑

```bash
PR_EVAL_ENV=.env scripts/eval/run.sh --limit=12                    # 小样本抽查
PR_EVAL_ENV=.env scripts/eval/run.sh --only=L4                     # 某一级
PR_EVAL_ENV=.env scripts/eval/run.sh                                # 全量 117 条(约 1 小时)
```

配了 `PHOENIX_COLLECTOR_ENDPOINT` 后,评测 trace 会进 `pr-agent-eval` 项目,
与生产(默认 `running-companion`)分开。
