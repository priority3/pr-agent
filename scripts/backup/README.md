# 异地备份(B2)

heyun 2026-08-30 整机失联事故的直接产物。数据持久化三层,职责不重叠:

| 层 | 机制 | RPO | 防什么 |
|---|---|---|---|
| 实时复制 | **Litestream** WAL 流式推 B2(`litestream.yml`) | 秒级 | 机器突然消失,最后几小时的对话/记忆 |
| 每日快照 | 本目录脚本(`backup-to-b2.sh`,cron) | ≤1 天 | 实时层自身故障/被污染;Write Only 密钥使其不可篡改 |
| 结构化镜像 | 活动 → Turso(admin 仓 `sync/mirror.ts`);admin.db → Turso(`db-mirror.ts`) | 分钟级 | 主站取数 + 可直接 SQL 查询的活副本 |

shared.db 始终是唯一真相源;所有层都只是副本,永不反向写回。

> 为什么「双写到 B2」是 WAL 流而不是逐行同步:对象存储只认整文件,不存在
> 行级写入;Litestream 在每次事务提交后把 WAL 增量片段(KB 级)推上去,
> 就是数据库对对象存储的正确"双写"形态。

## 全库清单与覆盖(共库部署)

| 库 | 内容 | 覆盖方式 |
|---|---|---|
| `shared.db`(卷 rpf_shared_data) | 活动/记忆/对话/复盘/健康/persona | 本脚本快照 + 活动另有 Turso 镜像 |
| `admin.db`(卷 runpaceflow-admin-data) | admin 配置(app_settings)、访问分析历史、audit | 本脚本快照 + 通用镜像 → Turso(admin 仓 `db-mirror.ts`,半小时一轮) |
| 主站 Turso 库 | 活动镜像 + insights | Turso 托管,本身即异地;insights 可再生 |
| `eval.db` / Phoenix 卷 | 评测隔离库 / trace | 可丢弃,不备 |

⚠️ 恢复/巡检时顺手确认 `/root/pr-agent/data/pr.db` **不存在**——它是 standalone
默认库,共库部署里出现它说明某容器 env 掉了、数据在静默分裂(见 .env.example 警告)。

## 布防(服务器上,一次性)

```bash
apt-get install -y sqlite3
curl https://rclone.org/install.sh | bash
rclone config create b2 b2 account=<Write-Only-keyID> key=<applicationKey>
crontab -e   # 加一行:
# 17 4 * * * /root/pr-agent/scripts/backup/backup-to-b2.sh >> /var/log/pr-backup.log 2>&1
```

B2 侧(**已于 2026-08-31 配置完成**,记录备查;重建 bucket 时重跑):

```bash
# 全桶 30 天版本轮转 + 默认服务端加密。月度档是唯一文件名、永不被新版本
# 隐藏,不受轮转影响;每日覆盖名的旧版本 30 天后自动清。
b2 bucket update --default-server-side-encryption SSE-B2 \
  --lifecycle-rule '{"daysFromHidingToDeleting":30,"fileNamePrefix":""}' \
  pr-agent allPrivate
```

密钥要求:rclone 用的应用密钥应为 **Write Only + 限定 pr-agent bucket**——
服务器被入侵也删不掉历史版本;轮转全靠上面的生命周期规则。

## 实时复制(Litestream,秒级 RPO)

standalone:`.env` 填好 `LITESTREAM_*` 三键(见 `litestream.yml` 头注)后
`docker compose --profile backup up -d` 即可。

共库部署(shared.db + admin.db 两库、两个命名卷)在服务器 compose 加:

```yaml
  litestream:
    image: litestream/litestream:0.3
    restart: unless-stopped
    command: replicate -config /etc/litestream.yml
    env_file: [.env]
    volumes:
      - rpf_shared_data:/data/shared
      - runpaceflow-admin-data:/data/admin
      - /root/litestream.yml:/etc/litestream.yml:ro
```

`/root/litestream.yml`(把仓库版的 dbs 段换成):

```yaml
dbs:
  - path: /data/shared/shared.db
    replicas:
      - { type: s3, bucket: pr-agent, path: litestream/shared,
          endpoint: ${LITESTREAM_S3_ENDPOINT}, sync-interval: 10s, retention: 72h }
  - path: /data/admin/admin.db
    replicas:
      - { type: s3, bucket: pr-agent, path: litestream/admin,
          endpoint: ${LITESTREAM_S3_ENDPOINT}, sync-interval: 10s, retention: 72h }
```

**密钥注意**:Litestream 要自行清理旧 WAL 代际,需要 Read & Write 密钥——
**不能**复用日快照那把 Write Only 的;单独建一把(仍限定本 bucket)。
两层因此互为保险:实时层密钥若被盗用删档,不可篡改的 Write Only 快照层仍在。

灾难恢复时优先从实时层还原(比日快照多救回当天的数据):

```bash
litestream restore -config /etc/litestream.yml -o shared.db /data/shared/shared.db
# 实时层不可用(代际损坏等)再退回日快照:见下方「恢复手册」
```

## bucket 内布局

```
db/shared-latest.db.gz          每日覆盖上传(旧日版本由 B2 版本机制保留 30 天)
db/admin-latest.db.gz           同上(admin 配置/访问分析)
db/monthly/<name>-YYYY-MM.db.gz 每月 1 号存档,长期保留
uploads/                        图片增量镜像
```

## 恢复手册

```bash
# 1. 取最新快照(或按版本/月度档取历史)
rclone copyto b2:pr-agent/db/shared-latest.db.gz ./shared.db.gz
gunzip shared.db.gz            # 若启用了 age 加密,先 age -d -i <私钥>
# 2. 放回数据卷,起服务
docker volume create rpf_shared_data
cp shared.db /var/lib/docker/volumes/rpf_shared_data/_data/shared.db
rclone copy b2:pr-agent/uploads /root/pr-agent/data/uploads
cd /root/pr-agent && docker compose up -d
# 3. 活动数据缺口(快照时点之后的)由 Keep 增量同步自动补;
#    也可反向核对主站 Turso 的镜像副本。
```

## 已知取舍

- 实时层(Litestream)与快照层(cron)刻意共存:前者管 RPO,后者管不可篡改
  与"实时层自身出问题"的兜底——两层用不同权限的密钥,互为保险。
- 备份跑在 host 而非容器内:VACUUM INTO 需要 sqlite3,而运行镜像(oven/bun)
  刻意保持精简;host cron 也不受容器重建影响。
- 更彻底的形态仍是整库切 Turso(`DATABASE_URL=libsql://`,原生支持)——
  届时本目录降级为 Turso dump 的快照工具。
