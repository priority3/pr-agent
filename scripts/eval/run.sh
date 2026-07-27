#!/usr/bin/env bash
# PR Agent 评测入口(推荐用这个,而不是直接 bun run scripts/eval/run.ts)。
#
# 为什么需要它:宿主机若装了 Claude Code 等工具,shell 里会带一堆全局 ANTHROPIC_* 变量
# (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_CUSTOM_HEADERS …)。
#   - bun --env-file 不会覆盖已存在的环境变量 → env-file 里的网关 BASE_URL 会被宿主的顶掉;
#   - ANTHROPIC_AUTH_TOKEN 会让 SDK 在 x-api-key 之外再塞 Authorization: Bearer → 不少网关直接 403。
# 所以这里在启动前先 unset 宿主的 ANTHROPIC_*/OPENAI_*,再用 env-file 干净地注入评测凭据。
#
# 用法:
#   PR_EVAL_ENV=/path/to/creds.env scripts/eval/run.sh [--only=L4] [--smoke] [--limit=5] [--case=id]
set -uo pipefail

unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL \
      ANTHROPIC_VISION_MODEL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_DEFAULT_SONNET_MODEL \
      ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL \
      OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL 2>/dev/null || true

# thinking 型模型预算:默认给足 3000,避免只出 thinking、正文为空(可覆盖)。
export PR_CHAT_MAX_TOKENS="${PR_CHAT_MAX_TOKENS:-3000}"

# 多模态用例的图片目录 —— 与生产 uploads 卷隔离。
export PR_UPLOAD_DIR="${PR_UPLOAD_DIR:-./data/eval-uploads}"

ENVFILE="${PR_EVAL_ENV:-.env}"
if [[ ! -f "$ENVFILE" ]]; then
  echo "[eval] env-file 不存在: $ENVFILE(用 PR_EVAL_ENV 指定含模型凭据的文件)" >&2
  exit 1
fi

cd "$(dirname "$0")/../.." || exit 1
# 注:隔离守卫(scripts/eval/isolate.ts)会无条件把 DATABASE_URL 改写成本地 eval 库,
# 所以即便 env-file 里是生产库地址,也不会写到 data/pr.db。
exec bun --env-file="$ENVFILE" scripts/eval/run.ts "$@"
