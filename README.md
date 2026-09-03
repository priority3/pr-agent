# PR

**一个记得你所有训练的跑步搭子。**

不是又一个"AI 健身助手"。PR 有你的手表数据、你的每一次跑步、你说过的每一句话——
所以你问它问题的时候,它是**真的去翻了你的数据**再回答的。

```
你:  我今天该练什么?我最近有条 6 公里的跑步记录。

PR:  3天前那6公里，今天就轻松跑个5公里左右找找感觉，
     配速比那天再松一点就行。
```

注意"**3天前**"——这句没人告诉它,是它自己去翻了记录。

---

## 它平时干什么

**早上手表一同步,它已经想好今天怎么练了。**
睡了 6 小时 40、深睡偏少、HRV 掉到 48——它不会跟你念数字,它会说"今天别硬上强度"。

**跑完一趟,它给你写复盘。**
不是"恭喜完成 10 公里!",是"后 3 公里掉了 20 秒配速,前面出得有点快"。

**你随口问,它认真查。**
"上个月最长跑多少"、"上次在这个天气跑得怎么样"——它会去翻活动记录、健康数据、
甚至查那天的天气,查不到就说查不到,不编。

**你说过的事它记着。**
"我膝盖最近不太舒服"、"我在备三月的半马"——这些会进它的长期记忆,以后自动避开或惦记着。
它记岔了的,可以通过管理接口改掉或删掉(见下"关于管理")。

**周末它会写日记。**
以一个老朋友的视角,回顾你这一周。

**它眼中的你,有一个数字分身。**
已确认的记忆会投影成一份结构化画像(`/api/pr/persona`:特征 + 渲染清单 + 成长史),
宿主面板用 3D 形象和浮动气泡把它画出来——你说过的伤病、目标、爱好都长在人物身边;
还能接入实时状态(presence)和个人 wiki(pr-lore 采集 → 蒸馏成候选记忆)。

---

## 上手

```bash
git clone https://github.com/priority3/pr-agent && cd pr-agent
cp .env.example .env     # 填 3 个值就能跑,见下
docker compose up -d
```

最少只要填这三个:

```bash
ANTHROPIC_API_KEY=sk-...        # 或用 OPENAI_* 那组
ADMIN_PASSWORD=你的管理密码
PR_CHAT_TOKEN=随便一串长随机字符    # 手机打开对话页的钥匙
```

起来之后:

- **手机上跟它聊**:`http://<你的地址>/pr?t=<PR_CHAT_TOKEN>`——存书签,以后点开就聊,不用登录

数据全在 `./data/pr.db` 一个文件里。备份用 `sqlite3 pr.db "VACUUM INTO '备份路径'"`
(库开着 WAL,直接 cp 可能拷出半截事务)。

## 关于管理

**它只提供对话页,没有内置管理后台。**

看它记住了什么、复盘写了什么、改掉它记错的东西——这些都是 HTTP 接口(`/api/pr/memories`、
`/api/pr/reviews`、`/api/pr/profile` 等,用 `ADMIN_PASSWORD` 登录换会话 cookie 后调用)。
你可以直接 curl,也可以接自己的界面(现成参考:[runPaceFlow-admin](https://github.com/priority3/runPaceFlow-admin)
的 PR 伙伴 / 数字分身 / 模型网关面板全部经这些接口实现)。完整清单见 [docs/reference.md](./docs/reference.md)。

## 让它认识你

**手表数据(睡眠 / HRV / 静息心率 / 步数)**
用 iOS「快捷指令」每天早上自动 POST 到 `/api/health/daily`。收到就触发当天的晨间反思。

**跑步记录**
POST 到 `/api/activities/import`,喂距离时长就行,有 GPX 更好。谁来喂都行 —— 手动、脚本、
或者交给 [runPaceFlow-admin](https://github.com/priority3/runPaceFlow-admin) 直采 Keep/Strava
后写同一个库(本进程不自己连数据源,见下)。

两个接口的完整字段见 [docs/ingest.md](./docs/ingest.md)。

## 换成你喜欢的组合

一切都是 env,不用改代码:

| 想换什么 | 怎么换 |
|---|---|
| **模型** | 任何 Anthropic 协议或 OpenAI 兼容的网关:env 填 `*_BASE_URL` + `*_MODEL`,或调 `/api/pr/settings` 运行时改,免重启 |
| **数据来源** | 通用导入接口 `POST /api/activities/import`,谁喂都行;要自动直采 Keep/Strava 就把 `DATABASE_URL` 指向 admin 写的那个库 |
| **推送** | 配 `PUSHPLUS_TOKEN` 就推微信;不配就安静待着 |
| **知识库检索** | 配 embedding 服务走向量+BM25 混检;不配就纯 BM25,照样能用 |
| **跟别的应用共用一个库** | `DATABASE_URL` 指向那个库,并设 `PR_SCHEDULER=off`——定时任务交给那边跑,否则同一份数据会被复盘两遍、通知推两次 |

完整配置项见 [`.env.example`](./.env.example),每个键都有注释。

## 几件想说清楚的事

- **单用户。** 它是为"一个人和他的跑步搭子"设计的,不是 SaaS。没有多租户,`friend_profile` 就一份。
- **数据是你的。** 一个 SQLite 文件,一个目录,没有云端账号,没有遥测。
- **它会承认不知道。** 提示词和工具链都在往"查不到就说查不到"上拧,而不是编一个听起来合理的数字。
- **记忆需要你点头。** 新记忆默认是候选状态,你确认过(调一下确认接口)、或它反复见到同一件事,才会变成它真正相信的东西。
- **管理界面不内置。** 只有对话页;管理是纯接口,想要界面就接自己的——数据在你的库里,谁都能读。

## 更多

- [数据摄入接口](./docs/ingest.md) — 两个入口的完整字段与示例
- [接口与配置参考](./docs/reference.md) — 全部 API、env 分组、目录结构
- [行为评测](./scripts/eval/README.md) — 109 条 L1–L4 用例,在隔离库里跑真实编排,出通过率与失败日志
- 本地开发:`npm install` → `bun run dev`(后端)+ `bun run dev:client`(前端)

---

PR 从 [RunPaceFlow](https://github.com/priority3/runPaceFlow-admin) 的陪伴模块抽离而来,现在可以单独跑了。
