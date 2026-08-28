# 数字分身(Persona Avatar)技术方案

> 2026-08-27。虚拟人物页:用户的 3D 数字分身 + PR 小跟班同框,周围浮动特征 tag 气泡,
> 形象随 pr-agent 记忆演进;后续接入 priority.me 实时状态与 pr-lore 个人 wiki。
> 决策(已确认):渲染走 3D(VRM);第一期页面落 runPaceFlow-admin 新菜单;数据只用 pr-agent(共库)。

## 0. 一句话架构

**所有持久特征单漏斗走既有记忆系统,persona 只是记忆之上的又一个投影**(和 `projectFriendProfile` 同构);
实时状态(presence)是独立的短时层,不落记忆。渲染端只消费一份确定性的「渲染清单」,3D 是可替换的皮。

```
持久信号(慢) ──────────────────────────────┐
  memory_items(active) ─┐                    │
  friend_profile        ├─ Persona 投影 job ─┼→ persona_state(渲染清单+traits,单例)
  health_daily_metrics  │  (规则+LLM蒸馏)    │   persona_events(变更史,成长回放)
  race_goals/activities ┘                    │
  [P4] pr-lore capture → MemoryCurator → 候选记忆(确认后自然汇入,不另开旁路)
                                             │
短时信号(快,不落库) ────────────────────────┤
  [P3] priority.me /api/presence(轮询) ──────┼→ live 字段(内存,TTL 5min)
                                             ↓
                GET /api/pr/persona (pr-agent,新)
                                             ↓
     admin「数字分身」菜单页:three.js+VRM 双人物 + DOM tag 气泡 overlay
     (共库部署下 admin 也可直读 persona_state 表 —— 见 §6 取舍)
```

## 1. 页面形态(对标 QQ 宠物截图)

- **主体**:用户的 VRM 数字分身站在场景中央,呼吸/待机动画;旁边一只小体型的 PR 伙伴
  (第一期可以是 2D 精灵图 billboard,后续再建模),表情反映它对你近期状态的判断
  (HRV 掉/睡眠差 → 担忧脸;连续达标 → 开心)。
- **tag 气泡**:环绕人物的圆形气泡,来自已生效(active)记忆与画像,按类型着色
  (目标/习惯/偏好/关系/伤病…)。点击气泡 → 抽屉显示原文、置信、证据、时间,
  并可跳到 admin 已有的记忆管理面板确认/编辑/归档 —— **气泡即记忆的可视化,不另造一套数据**。
- **场景道具**:由特征驱动的静态装饰(有半马目标 → 号码布挂墙上;爱好摄影 → 桌上相机)。
- **状态条**(P3):左上角「正在:VS Code 写码 / 听 xxx」,来自 priority.me presence。
- **成长回放**(P5):时间轴拖动看形象/气泡历史版本(persona_events 驱动)。

候选态记忆**不上形象**(与"记忆需确认"哲学一致):待确认的东西不该长在你身上。
可在页面角落给一个「待确认 N 条」入口引流到记忆面板。

## 2. 特征模型(trait schema)

persona_state 里的 traits 是**带命名空间的扁平键值**,每条带来源与置信:

```jsonc
{
  "schemaVersion": "persona.v1",
  "traits": [
    // body.*  身体(只来自显式记忆/画像,绝不推测 —— doNotAssume 同款红线)
    { "key": "body.height_cm", "value": 178, "confidence": 0.9,
      "source": { "kind": "memory", "refId": "mem_x" } },
    // identity.* 身份(称呼、生日…)
    { "key": "identity.nickname", "value": "rty", "confidence": 0.8, "source": {...} },
    // goal.* / hobby.* / habit.* / injury.*  直接映射记忆类型
    { "key": "goal.race", "value": { "type": "half_marathon", "month": 10 }, ... },
    // state.* 短周期状态(健康派生,规则计算,无 LLM)
    { "key": "state.training_load", "value": "recovering", ... },
    { "key": "state.mood", "value": "tired", ... }
  ],
  "renderManifest": { /* §4,由 traits 确定性解析而来 */ },
  "projectionVersion": 3,
  "builderVersion": "persona-v1",
  "updatedAt": "..."
}
```

提取规则分两路(与现有 projectFriendProfile 的做法同构):

- **确定性路**(代码规则,无 LLM):`state.*` 来自 health-derive/最近活动统计;`goal.race`
  来自 race_goals 表;`identity.nickname` 等来自 friend_profile。
- **LLM 蒸馏路**:把 active 记忆原文喂给一次模型调用,产出规范化 trait
  (如"身高一米七八"→ `body.height_cm: 178`)。失败降级:保留上一版 traits(投影是幂等重算,不怕跳过)。

**红线**:身体数值(身高/体重)只接受显式记忆,LLM 不得从跑步数据反推体重之类;
prompt 里复用画像的 `doNotAssume` 清单。

## 3. 渲染技术选型(3D 内部再选型)

| 方案 | 结论 |
|---|---|
| **VRM(VRoid Studio 建模)+ three.js + @pixiv/three-vrm** | **✅ 推荐** |
| Live2D Cubism | 备选。2D 动画最柔,但体型变化(身高/体重)表现力弱 —— 恰是需求核心;SDK 商用授权另算 |
| 裸 three.js 自建模 | 工作量最大,无必要 |

选 VRM 的理由:

1. **建模零成本工具链**:VRoid Studio 免费,滑杆式捏人(身高/体型/发型/服装),导出标准 .vrm。
2. **运行时可驱动**:three-vrm 暴露标准表情(happy/sad/relaxed…)blendshape、骨骼、
   VRMA 动画;traits → 表情/姿态/道具的映射都能在代码里做。
3. **体型映射有抓手**:
   - 身高 → 模型整体 scale(安全,视觉直观);
   - 体型(偏瘦/标准/壮)→ **预制 2~3 个 VRoid 变体模型**按 trait 选用,
     不做运行时骨骼缩放(容易穿模变形,不值得)。
4. 换装 = VRoid 里多做几套服装导出变体,或运行时切换服装 mesh 可见性(VRM 支持按 node 隐藏)。

素材管线(一次性投入):

```
VRoid Studio 捏基础形象 → 导出 base.vrm(压到 <15MB,VRM 支持纹理压缩)
  变体:body-slim.vrm / body-strong.vrm;服装 2~3 套
PR 小跟班:P1 用 2D 精灵图(AI 生图,透明底,3~5 个表情帧)做 billboard;P5 再考虑建模
待机动画:VRMA(呼吸/idle/开心小跳),Mixamo 重定向或手 K 简单曲线
资产放 admin public/persona/(页面在 admin,资产就近;哈希文件名 + immutable 缓存)
```

**tag 气泡不进 3D 场景**:DOM overlay 叠在 canvas 上(CSS 浮动动画 + 锚点微偏移),
文字清晰、点击/无障碍/主题适配都是白送的,比场景内 3D 文本便宜一个量级。
道具同理优先贴图/2D 装饰,只有确有必要才进场景。

## 4. renderManifest(traits → 视觉的确定性解析)

投影 job 的最后一步,把 traits 解析成渲染端**无脑执行**的清单(解析规则全在代码里,
版本号跟着走,前端不做任何业务判断):

```jsonc
{
  "manifestVersion": "rm.v1",
  "user": {
    "model": "base",              // base | body-slim | body-strong
    "scale": 1.04,                // 身高映射,clamp [0.92, 1.08]
    "outfit": "runner-default",
    "expression": "relaxed",      // state.mood 映射
    "idle": "breath",
    "props": ["race-bib-oct"]     // 场景道具 id
  },
  "companion": {                   // PR 小跟班
    "sprite": "pr-happy",          // state.training_load → happy|worried|cheering
    "bubble": "这周状态不错,周日照计划跑长距离?"   // 可选:复用最近反思的一句话
  },
  "tags": [
    { "id": "mem_x", "type": "goal", "label": "十月半马", "confidence": 0.85 },
    { "id": "mem_y", "type": "relationship_note", "label": "叫我 rty", "confidence": 0.8 }
  ],
  "live": null                     // P3 presence 注入,不持久化
}
```

## 5. 数据模型与 API(pr-agent 侧)

新表 2 张(延续 friend_profile 单例投影模式):

```sql
-- 单例投影:整份 persona.v1 JSON + 版本
CREATE TABLE IF NOT EXISTS persona_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  payload_json TEXT NOT NULL,          -- §2 traits + §4 renderManifest
  projection_version INTEGER NOT NULL DEFAULT 1,
  builder_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 变更史:每次投影 diff 非空才写一条(成长回放/审计)
CREATE TABLE IF NOT EXISTS persona_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- trait_added | trait_changed | trait_removed
  trait_key TEXT NOT NULL,
  before_json TEXT, after_json TEXT,
  source_ref TEXT,                     -- 触发的 memory id 等
  created_at INTEGER NOT NULL
);
```

投影触发(全部幂等重算,输入哈希不变则跳过 —— 沿用 state.ts 的 input_hash 惯例):

- 记忆 confirm / archive / patch 之后(挂在现有更新函数尾部,后台执行)
- friend_profile 重投影之后
- 健康上报之后(state.* 会变)
- 兜底 cron:每天一次(挂进 DEFAULT_JOBS,`CRON_PERSONA_PROJECTION` 可覆盖)

API(pr-agent 新增,复用现有鉴权中间件):

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/pr/persona` | 会话 | 完整 persona_state(admin 页主数据源) |
| `GET /api/pr/persona/history?limit=` | 会话 | persona_events 分页(P5 回放) |
| `POST /api/pr/persona/reproject` | 会话 | 手动触发重投影(调试/管理) |
| `GET /api/pr/persona/live` | 会话 | P3:代理合并 priority.me presence |
| `POST /api/pr/persona/ingest` | Bearer `LORE_INGEST_TOKEN` | P4:接收 lore.capture.v1 |

## 6. admin 侧集成(第一期落点)

新菜单「数字分身」(侧边栏 PR 伙伴下方),页面组成:

- three.js canvas(VRM 加载 + 待机动画,加载中放剪影骨架屏 —— VRM 十几 MB,必须有加载态)
- tag 气泡 overlay + 点击抽屉(证据/置信,「去管理」跳 MemoryPanel)
- PR 小跟班精灵 + 气泡话

**取数方式(明确取舍)**:本部署 admin 与 pr-agent 共库(shared.db),admin 直读
`persona_state` 一张表即可 —— 用**一条 raw select**(`SELECT payload_json FROM persona_state`),
**不要**把 persona 表加进 admin 的 drizzle schema。理由:上一轮已确认两仓 schema 双份维护是
现存最大技术债,persona 的 DDL、投影逻辑、解析规则必须只有 pr-agent 一个 owner;
admin 只消费最终 JSON,连表结构都不感知,将来面板切到调 pr-agent API 时零改动。

依赖新增(admin):`three` + `@pixiv/three-vrm`(懒加载,只在本页 dynamic import,
不进 dashboard 首包)。

## 7. 后续接入

### P3 priority.me presence(实时层)

协议现成:ProcessReporter → `POST /api/presence`(MixSpace 格式),
`GET /api/presence` 已做公开脱敏(process 名/媒体信息/online + TTL 5 分钟)。

- pr-agent 侧 `GET /api/pr/persona/live` 服务端轮询/透传 priority.me 的 GET
  (浏览器直连会撞 CORS,且 pr-agent 收口后 H5/公开页将来可复用),内存缓存 30s。
- 映射:`processName` → 预置词表(Code→"写码中" 场景亮屏道具;Chrome→"冲浪中";
  media → "听 {title}" 气泡)。**presence 永不落记忆/traits** —— 短时状态没有确认语义。

### P4 pr-lore(个人 wiki → 兴趣特征)

关键决策:**capture 不直连 traits,走既有记忆漏斗**。

- pr-lore 加一个 Deliverer webhook 目标(其架构原生支持)→
  `POST /api/pr/persona/ingest`(Bearer token,body 即 lore.capture.v1)。
- pr-agent 收到后喂给现有 MemoryCurator 蒸馏为**候选记忆**
  (evidence.source = 'lore',refId = capture id,quote = 摘要),
  确认/多证据晋升后自然出现在形象上。
- 尊重 `privacy.level`:`private` 的 capture 蒸馏出的记忆打私密标记,
  将来做公开页时按此过滤;`allow_cloud_llm=false` 的跳过 LLM 蒸馏(只留人工入口)。

好处:tag 气泡永远只有一个数据源(记忆),不会出现"wiki 说爱好 A、记忆说爱好 B"两套真相。

## 8. 分期计划

| 期 | 内容 | 验收 |
|---|---|---|
| **P0 数据层** | persona_state/events 表 + 投影 job(规则路+LLM 路)+ GET API;记忆变更钩子 | curl `GET /api/pr/persona` 出 traits+manifest;确认一条记忆后 30s 内投影更新 |
| **P1 页面骨架** | admin 新菜单;VRM 默认模型加载 + 待机动画;tag 气泡 overlay + 证据抽屉 | 页面能看:人物站着呼吸,气泡与记忆面板数据一致,点击可跳管理 |
| **P2 形象驱动** | renderManifest 全量接通:体型变体/身高 scale/表情/服装/道具;PR 小跟班精灵 + 状态表情 | 改一条身高记忆并确认 → 刷新后人物变高;HRV 连续低 → 小跟班变担忧脸 |
| **P3 实时层** | presence 代理 + 状态条 + 场景反应 | 打开 VS Code 一分钟内页面显示"写码中" |
| **P4 lore 接入** | ingest 端点 + lore webhook deliverer 配置 + 隐私标记 | lore 采集一篇摄影文章 → 候选记忆出现 → 确认后"摄影"气泡上身 |
| **P5 可玩性** | 成长回放时间轴;换装收集;(可选)喂养/等级 —— 跑量喂 PR 小跟班升级 | — |

P0 与 P1 可并行(P1 先用 mock manifest);P2 依赖两者。素材(VRoid 捏人 + 小跟班精灵图)
是独立工作流,建议 P1 期间同步做。

## 9. 风险与取舍

- **3D 是本方案最大成本项**。已通过分层把它隔离成"皮":P0 的数据/投影层与渲染无关,
  哪怕 VRM 路线做一半改主意(换 Live2D / 换参数化 SVG),traits 与 manifest 全部复用,
  只重写解析表和 canvas 组件。
- **VRM 体积**(10~20MB):首屏懒加载 + 骨架屏 + immutable 缓存;admin 是自用面板,可接受。
- **体重/体型运行时变形不做**:预制变体模型代替骨骼缩放,宁可档位粗一点也不要穿模。
- **admin 直读共库是权宜**:与上一轮"拆干净"方向的妥协点已收窄到"一条 raw select";
  persona 一切逻辑 owner 在 pr-agent,后续面板整体切 API 时本页零逻辑迁移。
- **LLM 蒸馏失败**:保留上一版投影,页面永远有东西可渲染(与 RAG 降级同哲学)。
- **隐私**:本期页面在 admin(会话鉴权)无暴露面;公开页(priority.me)属 P5+,
  届时按 trait 命名空间 + lore privacy.level 做白名单输出,伤病/生日类默认不出。
