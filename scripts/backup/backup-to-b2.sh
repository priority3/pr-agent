#!/usr/bin/env bash
#
# shared.db + uploads → Backblaze B2 冷快照。
#
# 数据持久化策略的后一半(前一半是 admin 仓的活动镜像 → 主站 Turso):
# 记忆/对话/复盘/健康/persona 只存在于 shared.db,本脚本每天把它的一致性快照
# 推到异地对象存储,防服务器整机丢失(2026-08-30 heyun 失联事故的直接教训)。
#
# 用法(部署机 root crontab):
#   17 4 * * * /root/pr-agent/scripts/backup/backup-to-b2.sh >> /var/log/pr-backup.log 2>&1
#
# 前置(一次性):
#   1. apt-get install -y sqlite3            # 一致性快照用(VACUUM INTO)
#   2. 安装 rclone: curl https://rclone.org/install.sh | bash
#   3. rclone 配置 B2 remote(用 Write Only 应用密钥,防入侵删备份):
#      rclone config create b2 b2 account=<keyID> key=<applicationKey>
#   4. bucket 生命周期负责轮转(本脚本只写不删,Write Only 密钥也删不了):
#      b2 bucket update --lifecycle-rule '{"daysFromHidingToDeleting":30,"fileNamePrefix":"db/"}' pr-agent allPrivate
#
# 环境变量(均有默认值,共库部署直接用;standalone 部署按需覆盖):
#   PR_BACKUP_DB       shared.db 路径(默认 docker 卷 rpf_shared_data 内)
#   PR_BACKUP_UPLOADS  uploads 目录(默认 /root/pr-agent/data/uploads)
#   PR_BACKUP_REMOTE   rclone 目标(默认 b2:pr-agent)
#   PR_BACKUP_AGE_RECIPIENT  可选:age 公钥,设置则上传前客户端加密
#
# 恢复流程见同目录 README.md。
set -euo pipefail

DB_PATH=${PR_BACKUP_DB:-/var/lib/docker/volumes/rpf_shared_data/_data/shared.db}
UPLOADS_DIR=${PR_BACKUP_UPLOADS:-/root/pr-agent/data/uploads}
REMOTE=${PR_BACKUP_REMOTE:-b2:pr-agent}
AGE_RECIPIENT=${PR_BACKUP_AGE_RECIPIENT:-}

command -v sqlite3 >/dev/null || { echo "[backup] 缺 sqlite3,先 apt-get install sqlite3"; exit 1; }
command -v rclone >/dev/null || { echo "[backup] 缺 rclone,见脚本头部安装说明"; exit 1; }
[ -f "$DB_PATH" ] || { echo "[backup] 找不到库文件: $DB_PATH(用 PR_BACKUP_DB 覆盖)"; exit 1; }

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
STAMP=$(date +%F)

# 1) 一致性快照:VACUUM INTO 会连 WAL 里未 checkpoint 的事务一起固化,
#    产物是独立完整的库文件——直接 cp 正在写入的 .db 则可能拷出半截事务。
SNAP="$WORKDIR/shared-$STAMP.db"
sqlite3 "$DB_PATH" "VACUUM INTO '$SNAP'"
gzip -9 "$SNAP"
ARTIFACT="$SNAP.gz"

# 2) 可选客户端加密(库里是健康/记忆数据;B2 侧另有 SSE,这里是纵深防御)。
if [ -n "$AGE_RECIPIENT" ]; then
  command -v age >/dev/null || { echo "[backup] 设置了 AGE_RECIPIENT 但缺 age"; exit 1; }
  age -r "$AGE_RECIPIENT" -o "$ARTIFACT.age" "$ARTIFACT"
  ARTIFACT="$ARTIFACT.age"
fi
EXT=${ARTIFACT#*.db}

# 3) 上传。固定文件名 = 每天生成新版本,旧版本由 bucket 生命周期规则保留/清理;
#    每月 1 号额外留一份月度存档(不同名,长期保留)。
rclone copyto "$ARTIFACT" "$REMOTE/db/shared-latest.db$EXT"
if [ "$(date +%d)" = "01" ]; then
  rclone copyto "$ARTIFACT" "$REMOTE/db/monthly/shared-$(date +%Y-%m).db$EXT"
fi

# 4) uploads 增量同步(图片本来就是文件,不走快照;本地已删的远端隐藏 30 天后清)。
if [ -d "$UPLOADS_DIR" ]; then
  rclone sync "$UPLOADS_DIR" "$REMOTE/uploads"
fi

echo "[backup] $STAMP 完成: $(du -h "$ARTIFACT" | cut -f1) → $REMOTE"
