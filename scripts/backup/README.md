# 异地备份(B2 冷快照)

heyun 2026-08-30 整机失联事故的直接产物。数据持久化整体策略两条腿:

| 数据 | 机制 | 位置 |
|---|---|---|
| 活动/GPS(体积大、本就公开) | 同步后双写镜像(admin 仓 `sync/mirror.ts`) | 主站 Turso(**活副本**,RPO≈0) |
| 记忆/对话/复盘/健康/persona + uploads | 本目录脚本,每日冷快照 | Backblaze B2(**死备份**,RPO≤1 天) |

shared.db 始终是唯一真相源;两条腿都只是副本,永不反向写回。

## 全库清单与覆盖(共库部署)

| 库 | 内容 | 覆盖方式 |
|---|---|---|
| `shared.db`(卷 rpf_shared_data) | 活动/记忆/对话/复盘/健康/persona | 本脚本快照 + 活动另有 Turso 镜像 |
| `admin.db`(卷 runpaceflow-admin-data) | admin 配置(app_settings)、访问分析历史、audit | 本脚本快照(默认列表已含) |
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

B2 侧(本地用已授权的 b2 CLI,一次性):

```bash
# 30 天版本轮转 + 默认服务端加密
b2 bucket update --default-server-side-encryption SSE-B2 \
  --lifecycle-rule '{"daysFromHidingToDeleting":30,"fileNamePrefix":"db/"}' \
  --lifecycle-rule '{"daysFromHidingToDeleting":30,"fileNamePrefix":"uploads/"}' \
  pr-agent allPrivate
```

密钥要求:rclone 用的应用密钥应为 **Write Only + 限定 pr-agent bucket**——
服务器被入侵也删不掉历史版本;轮转全靠上面的生命周期规则。

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

- RPO ≤ 1 天:快照间隔内的对话/记忆会丢。对单用户陪伴系统可接受;
  不可接受时的升级路径是整库切 Turso(`DATABASE_URL=libsql://`,原生支持)。
- 备份跑在 host 而非容器内:VACUUM INTO 需要 sqlite3,而运行镜像(oven/bun)
  刻意保持精简;host cron 也不受容器重建影响。
