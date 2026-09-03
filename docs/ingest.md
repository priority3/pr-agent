# 数据摄入

两条入口,都不需要任何第三方账号。鉴权都是 **Bearer `HEALTH_IMPORT_TOKEN`**(或管理端会话 cookie)。

## 健康数据 — `POST /api/health/daily`

睡眠 / HRV / 静息心率 / 步数 / 环境音量。典型用法是 iOS「快捷指令」每天早上起床后自动上报。

按 `(date, source)` 幂等 upsert;`date` 省略时按 Asia/Shanghai 取今天。**落库即非阻塞触发当天的晨间反思。**

### 形状 A:上报原始睡眠分段(推荐)

服务端 `deriveSleep` 自己派生聚合值,还能识别白天小睡、剔除过期数据(手表没戴时快捷指令会重复上报旧睡眠)。

```jsonc
{
  "date": "2026-07-24",              // 可选,YYYY-MM-DD,省略 = 今天(CST)
  "source": "apple_health",          // 可选,与 date 组成幂等键
  "sleepSegments": [                 // 或 sleepSegmentsText:每行 "stage|startISO|endISO|durSec"
    { "stage": "core", "start": "2026-07-23T23:10:00+08:00", "end": "2026-07-24T06:40:00+08:00" }
  ],
  "napSegments": [],                 // 可选,白天小睡
  "hrv": 62,
  "restingHr": 48,
  "steps": 8213,
  "audioAvgDb": 41,                  // 可选,环境音量
  "audioMaxDb": 78
}
```

### 形状 B:直接上报聚合值

调用端自己算好了就用这个。

```jsonc
{
  "date": "2026-07-24",
  "sleepMinutes": 450,
  "deepSleepMinutes": 95,
  "remSleepMinutes": 110,
  "hrv": 62,
  "restingHr": 48,
  "steps": 8213,
  "payload": { }                     // 可选,原始事实存档
}
```

> 睡眠过期保护:若最近一次醒来距今超过 20 小时(通常是没戴表),睡眠摘要会被置空而不是把旧数据当昨晚,
> 反思里也会明说"没读到昨晚睡眠"。

## 活动数据 — `POST /api/activities/import`

没有 Keep / Strava 时的默认通路。喂 `RawActivity`:单个对象、数组,或 `{ "activities": [...] }`。

按 `(source, id)` 去重后写入,有 GPX 就解析出每公里明细,没有就按均速生成。

```jsonc
{
  "id": "run-2026-07-24",                     // 必填,数据源内唯一(幂等键)
  "source": "manual",                         // 必填,来源标识
  "startTime": "2026-07-24T06:30:00+08:00",   // 必填,ISO 字符串或 epoch 毫秒
  "type": "running",                          // running|cycling|walking|swimming|other,默认 running
  "distance": 10230,                          // 米
  "duration": 3180,                           // 秒
  "title": "晨跑",                            // 可选
  "isIndoor": false,                          // 可选
  "gpxData": "<gpx>…</gpx>",                  // 可选,提供则解析轨迹并生成 split
  "averagePace": 311,                         // 可选,秒/公里
  "bestPace": 288,
  "elevationGain": 42,                        // 可选,米
  "averageHeartRate": 152,
  "maxHeartRate": 171,
  "calories": 640
}
```

返回 `{ imported, skipped, errors? }`。

## 自动同步

本进程**不直连 Keep/Strava**。直采数据源是 [runPaceFlow-admin](https://github.com/priority3/runPaceFlow-admin)
的职责:它每小时增量拉一次并写 `activities` 表,把 `DATABASE_URL` 指向同一个库,这里读到的就是它同步的结果。

Reason: 同步要处理凭据轮换、分运动类型的增量游标、跨源判重、赛事匹配这些数据平面的事,
和本进程「记忆 / 复盘 / 对话」的职责是两回事;两边各留一套只会漂移(历史上确实漂过)。
只想要一个纯 agent、不想跑 admin 的话,用上面的通用导入接口自己喂即可。

新活动无论从哪条路进来,都会自动生成复盘;只有近 24 小时完成的活动才会推送通知,历史回填静默入库。

### 富化开关

两个默认关闭的增强,按需打开:

- `ENRICH_WEATHER=1` — 用 open-meteo(免 key)补活动当时的天气
- `ENRICH_RACE_MATCH=1` — 赛事名匹配。**standalone 未打包匹配器**(依赖 Playwright),置开仅告警
