# 各家 agent 每轮注入的提示词结构（横向调研）

调研目标：PR 的提示词到底该长什么样。结论先说——**各家都不是"一个大 system prompt"，而是分层装配**；
并且长度差异极大：Codex 基座 2.1 万字符，opencode 基座 756 字符，Claude Code 用 500+ 个
按需加载的子提示词。PR 当前 2101 字符，真正的问题不是"太长"，而是**分层不干净**。

调研时间：2026-10-20。来源均为各家公开仓库源码（见每节末尾）。

---

## 0. 共性骨架：七层

| 层 | 内容 | 稳定性 | 角色/位置 |
|---|---|---|---|
| L0 身份基座 | 你是谁、口吻、能力边界 | 永久稳定 | system，放最前，打缓存断点 |
| L1 工具 schema | 工具名/描述/参数 | 基本稳定 | **原生 tools 参数，不在提示词里** |
| L2 运行时事实 | cwd、平台、日期、shell、git 状态、模型名 | 每轮变 | user/developer 消息块，带标签 |
| L3 项目/用户规则 | CLAUDE.md / AGENTS.md | 按仓库稳定 | user 消息注入（不是 system） |
| L4 记忆与知识 | 长期记忆、检索命中 | 半稳定 | 独立区块，带来源标签 |
| L5 按需能力 | 技能 / 插件 / 子 agent / 专家 | 命中才有 | 命中才注入，不常驻 |
| L6 本轮输入 | 用户消息 + 附件 + 动态提醒 | 每轮变 | 最后一条 user 消息 |

共同点（这是最值得抄的）：

1. **L0 极窄且永久稳定**——只放身份、口吻、硬性边界，为的是跨轮缓存命中。
2. **工具语义只在 schema**，提示词不复述工具用法。
3. **事实与守则分声道**：事实进带标签的数据块，守则进 L0/L3，不混在一段里。
4. **规则的条件化**：有某项能力/数据才注入对应规则（Codex 的 plugin/MCP、opencode 的 model-specific、
   Claude Code 的子 agent 提示词）。
5. **动态提醒挂在用户轮**（`system-reminder`），而不是塞进 system。

---

## 1. Claude Code（Anthropic）

结构：内置 system prompt + 27 个内置工具描述 + CLAUDE.md 三层 + `<system-reminder>` 动态块 + 大量按需子提示词。

- **CLAUDE.md 是三层合并，以 user 消息注入，不是 system**：全局 `~/.claude/CLAUDE.md`（个人偏好）、
  项目根 `./CLAUDE.md`（团队约定）、子目录 `./src/CLAUDE.md`（模块级覆盖）。文档明确说它
  "treated as context, not enforced configuration"——要强制得上 hooks。
- **子提示词按需加载**：社区镜像统计到 **515 个提示词 / 961 个 md 文件**
  （v2.1.303，2026-10-18），命名形如 `agent-prompt-code-review-part-3-*.md`、
  `agent-prompt-background-agent-state-classifier.md`。也就是说：评审、后台任务、标题生成、
  slash 命令各有一份自己的小提示词，用到才装。
- **动态事实用 `<system-reminder>` 挂在用户轮**（日期、文件变更、todo 状态等）。

来源：`Piebald-AI/claude-code-system-prompts`（README + `system-prompts/*.md` 961 个文件）。

## 2. Codex（OpenAI）

分层做得最彻底。核心抽象是 `ContextualUserFragment`（`codex-rs/core/src/context/mod.rs`），
**每一片上下文都是带类型的片段**：

```rust
impl ContextualUserFragment for X {
    fn role(&self) -> &'static str { "developer" }        // 或 "user"
    fn content_kind(&self) -> ContentItemKind { ... }      // 稳定 kind，如 "model.base_instructions"
    fn markers(&self) -> (&'static str, &'static str)      // 开闭标签，如 "<model_instructions>"
    fn body(&self) -> ContentItem { ... }
}
```

`mod.rs` 里注册的片段约 50 个，按职责分：

| 类别 | 片段 |
|---|---|
| 基座 | `base_instructions`(`model.base_instructions`) · `model_instructions` · `model_switch_instructions` |
| 用户/开发者 | `user_instructions`(AGENTS.md，包在 `<INSTRUCTIONS>`) · `developer_instructions` |
| 环境 | `environment_context` · `environments_instructions` · `current_time_reminder` |
| 能力 | `plugin_instructions` · `apps_instructions` · `available_plugins_instructions` · `recommended_plugins_instructions` |
| 记忆/历史 | `memory` · `compaction_summary` · `guardian_conversation_history` |
| 多 agent | `multi_agent_mode_instructions` · `multi_agent_usage_hint` · `inter_agent_message` |
| 运行态 | `token_budget_context` · `rollout_budget` · `turn_aborted` · `unsupported_media` 等 |

- **基座按模型分文件**：`codex-rs/core/gpt_5_2_prompt.md`（**21524 字符**）、
  `gpt-5.1-codex-max_prompt.md`、`gpt_5_codex_prompt.md` 等，开头是
  "You are GPT-5.2 running in the Codex CLI…" → Personality / How you work / Sandbox and approvals 等章节。
- **AGENTS.md 走 user 角色**：`UserInstructions` 的 `role()` 返回 `"user"`，body 包成
  `<INSTRUCTIONS>…</INSTRUCTIONS>`，并标注目录。
- **环境说明单独一片**：`EnvironmentsInstructions` 只讲"远程执行环境还没就绪时怎么办"，
  用 `<environment_context>` 开闭标签。

关键收益：每片有稳定 `content_kind` + 开闭标记 → 支持**增量上下文窗口**（只重发变化的片）
和精细的缓存复用。

来源：`github.com/openai/codex`，`codex-rs/core/src/context/*.rs`、`codex-rs/core/*_prompt.md`。

## 3. opencode（anomalyco）

基座极短，靠"按需 + 按模型"补充：

- **主基座只有 756 字符**（`packages/core/src/session/runner/prompt/system.txt`）：
  身份一句 + `# Harness`（markdown 渲染、`<system-reminder>` 是系统指令不是用户内容、并行调用工具）
  + `${OPENCODE_TOOL_GUIDANCE}` 占位符 + `# Communication` + `# Working in codebases`。
- **按模型追加极小的适配提示词**（`packages/core/src/plugin/system-prompt/`）：
  `anthropic.txt` **300 字符**（只讲代码注释密度）、`gpt.txt`、`kimi.txt`、`meta.txt`、`trinity.txt`。
- **项目规则走 AGENTS.md**（兼容 fallback 到 CLAUDE.md），由 `instruction-discovery.ts` 发现、
  `session/instructions.ts` 装配；规则可带 frontmatter 声明作用范围。
- **子 agent 按需**：内置 `build`（全权限）/ `plan`（只读），子 agent `general` / `explore` / `scout`，
  自定义子 agent 放 `.opencode/agents/*.md`。

来源：`github.com/anomalyco/opencode`（dev 分支），`packages/core/src/session/runner/prompt/system.txt` 等。

## 4. WorkBuddy（本机运行环境，从运行时行为观察）

分层同样是"小基座 + 大量按需"：

| 层 | 表现 |
|---|---|
| 身份 | 产品身份 + 助手名，一句话 |
| 工具 | 大量工具 schema 常驻（文件/命令/搜索/联网/多模态/任务等），用法只在 schema |
| 环境 | 工作区路径、平台、shell、当前日期、IDE 主题、项目结构快照 |
| 记忆 | **以文件注入**：用户级 `MEMORY.md` + 项目级 `.workbuddy/memory/`（当日日志 + 长期 MEMORY.md） |
| 能力 | 技能 / 专家 / 连接器：**只在命中时把该技能的指令读进来**，不常驻 |
| 调度 | 自动化任务（一次性/周期）单独一套 |
| 输入 | 用户消息 + 图片附件 + 引用材料 |

值得注意的两点：① 记忆是"文件注入"而不是把记忆内容写进提示词模板；② 能力指令按需加载，
所以常驻提示词可以很短。

## 5. 对照：PR 现在站在哪

| | 基座提示词 | 工具 schema | 环境事实 | 项目/用户规则 | 记忆 | 按需能力 | 用户轮 |
|---|---|---|---|---|---|---|---|
| Claude Code | 内置（不公开） | 27 个工具 | `<system-reminder>` | CLAUDE.md 三层（user 角色） | 自动记忆 | 500+ 子提示词 | 消息+提醒 |
| Codex | **21.5K 字符**/模型 | 原生 tools | `environment_context` | AGENTS.md（user 角色） | `memory` 片 | 插件/多agent 片 | 消息 |
| opencode | **756 字符** + 模型适配 300 | 原生 tools | 少量 | AGENTS.md | — | 子 agent/技能 | 消息 |
| WorkBuddy | 短身份块 | 大量原生 tools | 环境块 | — | 记忆文件注入 | 技能/专家按需 | 消息+图片 |
| **PR** | **2101 字符**（含事实用法说明） | 4–5 个 ≈1685 字符 | `<context>` 区块（providers） | 无 | `memory` provider | 无（全部常驻） | 消息+图片 |

PR 的差距不在长度，在这三点：

1. **条件注入缺失**：赛程口径、同步口径、赛事资料这些规则无条件常驻，哪怕这轮没有赛事计划、没配同步入口。
   Codex/opencode 的做法是"有插件才注入插件说明、有 AGENTS.md 才注入规则"。
2. **事实与守则同声道**：`<context>` 块里塞了行为指令（"别用原话里的隔一周"），
   而这些本该是"数据行 + 代码硬校验"（`checkRaceSchedule` 已经做了后者）。
3. **没有稳定 kind / 开闭标记**：PR 的 block 只有 title + lines，没有 Codex 那样的 `content_kind`，
   因此未来想做增量上下文或精细缓存断点时无从下手。

## 6. 建议的 PR 分层（只改组织方式，不删内容）

```
L0 身份与口吻          ~300 字符   永久稳定，缓存断点前
L1 边界与安全          ~500 字符   永久稳定（不外泄、不谎称已执行、就医提醒、不外发）
L2 运行时事实          动态        providers 产出，每个 block 加 kind + 开闭标记（稳定排序）
L3 条件规则            命中才注入   有赛事计划 → 赛程口径；有同步工具 → 同步口径；带图片 → 图片口径
L4 本轮输入            动态        用户原话 + 图片
硬校验                evaluator   不占提示词
```

落地顺序（可单独做，互不影响）：
1. 给 `ContextBlock` 加 `kind` 字段 + 开闭标记，保持排序稳定（对齐 Codex 的 fragment 抽象）。
2. 把"只有某类数据存在时才成立"的规则从 L0 挪到 L3 条件注入（赛程、同步、赛事资料）。
3. 剩余 L0 只留身份 + 口吻 + 边界，目标 ~800 字符。
4. 跑 `bun run eval`（117 条）确认不掉分——**本仓无 `.env` 与 API key，回归需要补 key 才能验证**。

### 落地记录（2026-10-21，前三步已完成）

| 步 | 改了什么 | 结果 |
|---|---|---|
| ① kind/标记 | `providers/types.ts` 的 `ContextBlock` 加 `kind`；`buildChatContextTurn` 把每块渲染成 `<kind>…</kind>` | 每块可独立定位，为增量窗口/缓存对齐留了抓手 |
| ② 事实与守则分声道 | 删掉 `activities` 标题和 `race-goals` 间隔行/待确认行里的指令文字；`<context>` 头也删掉与提示词重复的"用工具查" | 数据块只剩数据；口径全在提示词的条件块，硬校验在 `checkRaceSchedule` |
| ③ 条件注入 | `buildChatSystemPrompt({ hasRace, hasSync })`：有赛事计划才注入 3 条赛程口径；有同步工具才注入 2 条同步口径，**没有同步入口时改为注入 1 条"这个环境拉不了、不许承诺"** | 提示词从固定 2101 变成 1607～2140 |

```
无赛事 + 无同步  1607 字符    ← 最常见（其中 43 字符是"没接同步入口"那条）
无赛事 + 有同步  1786
有赛事 + 无同步  1961
有赛事 + 有同步  2140        ← 与改造前(2101)基本持平
```

判定依据全部来自编排层已经拿到的东西，不额外查库：`hasRace = 库里有赛事计划 || 本轮提取到了`、
`hasSync = providerTools() 里出现了 sync_activities`。system 串每轮只算一次并复用给重写轮。

---

## 待确认

- **dsh** 指哪个产品没查到（可能是某个内部/小众工具名），需要指个仓库或文档我再补一节。
