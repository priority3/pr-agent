# 聊天赛事计划与资料

聊天会在回复前提取用户本轮文字及图片中的未来参赛计划。一场赛事一条 `race_plans`，保存用户名称、城市、距离、绝对日期、原话、消息 ID、发送时间，以及图片来源。`下个月18号和25号，一个遂宁一个成都` 按消息发送时间的 Asia/Shanghai 日期计算；截图里的相对日期没有原消息时间时保留待确认。

明确计划会在同一数据库事务内写入 `race_plans`、`race_goals`、`memory_items` 和审计事件。没有成绩目标时 `target_type=participate`，不会推断完赛时间。模糊意图、缺日期或缺距离的计划保存为 `needs_confirmation`，不创建正式目标；后续明确给出同名赛事完整信息可合并。修改/删除正式目标会同步关联记忆，并清除已不适用的赛事资料。

资料单独保存在 `race_plans.research_json`，不写成用户自述记忆。内容包括官方名称、日期、路线、起终点、海拔、累计爬升、坡段、补给、关门时间，每项分别保留状态、原文引文和来源索引。来源记录 URL、页面标题、赛事资料年份和抓取时间。

- `verified`：当年、同组别、官方来源且引文可在正文定位。
- `unverified`：非官方来源，保留出处待核实。
- `pending`：官方原文明示尚未公布。
- `unavailable`：未查到该字段；不代表官方没公布。
- `conflict`：日期或来源冲突，不作为确认事实。

默认通过 Bing RSS 搜索，配置 `TAVILY_API_KEY` 后改用 Tavily。搜索只发送赛事名称/城市/年份/距离，不发送原话、健康或训练数据。政府 `.gov.cn` 资料作为官方来源；已核实的赛事官网配置到 `PR_RACE_OFFICIAL_HOSTS`（逗号分隔域名），其他来源一律待核实。网页正文必须能读取，当前不解析图片版路线图、PDF 或 GPX，不从城市平均海拔估算赛道爬升。

新建的明确赛事会主动查资料；后续对话 `query_race_details` 可读取或刷新单场资料，默认缓存 24 小时，网络失败缓存 5 分钟。认证管理 API：

- `GET /api/pr/race-goals/plans`：读取计划、用户来源与资料。
- `POST /api/pr/race-goals/plans/:id/research`：刷新资料，JSON `{}` 或 `{"sourceUrls":["https://赛事官网/规程"]}`。

已有历史对话不自动批量重提取，避免给没有时间戳的旧截图套用今天。明确重新发送原始赛事消息即可按上述规则保存。已完成赛事成绩仍属于 `activities`。

验证：`bun run scripts/test-race-plans.ts` 使用新建临时 SQLite 库和可复现网页/模型返回，验证日期、去重、证据、缺失/冲突、缓存以及记忆同步；不会修改真实库。`npm run typecheck` 和 `npm run build` 验证编译。
