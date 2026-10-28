#!/usr/bin/env bash
#
# 在阿里云上把知行Bot的「远程电脑」跑起来（Bot 的活就在这台容器里干）。
# 前置：scripts/deploy-aliyun.sh 已经成功部署过合并应用（服务器上有 /opt/duowei-src 源码、
# $REMOTE_ZHIXINGBOT_ENV、zhixingbot-net 网络、zhixingbot-postgres）。本脚本幂等，可重复跑（重复跑会轮换 token）。
#
# 步骤：登记电脑行 + 写启动文件 → 传 seccomp 配置 → 服务器侧构建 zhixingbot-remote 镜像
# （chromium+xvfb+bwrap，只在不存在时构建，极重）→ 起容器 → 冒烟。
#
# 资源提醒：chromium+xvfb 建议 ≥4G 内存。机器只有 1.7G 时会告警——能跑，但浏览器一开会抖。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
ENV_FILE="$ROOT/aliyun.env"

REMOTE_ZHIXINGBOT_DIR="/opt/duowei/zhixingbot"
REMOTE_ZHIXINGBOT_ENV="$REMOTE_ZHIXINGBOT_DIR/zhixingbot.env"
REMOTE_BOTS_DIR="/opt/duowei/bots"
REMOTE_RUN_DIR="$REMOTE_ZHIXINGBOT_DIR/run"
ZHIXINGBOT_NETWORK="zhixingbot-net"
REMOTE_IMAGE="localhost/zhixingbot-remote:latest"
REMOTE_CONTAINER="zhixingbot-remote"
REMOTE_SRC_DIR="/opt/duowei-src"
# 合并应用容器在 zhixingbot-net 里的名字就是 duowei。
AGENT_URL="ws://duowei:8787/assistant/agent"
APT_MIRROR="${ZHIXINGBOT_APT_MIRROR:-mirrors.aliyun.com}"
MIN_MEM_KB=$((3 * 1024 * 1024))
APP_IMAGE="docker.io/library/duowei:latest"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE" >&2
  exit 1
fi
HOST="$(sed -n '2p' "$ENV_FILE" | tr -d '[:space:]')"
SSH_USER="$(sed -n '3p' "$ENV_FILE" | tr -d '[:space:]')"
export SSHPASS="$(sed -n '4p' "$ENV_FILE" | tr -d '\r\n')"
SSH_OPTS=(-o StrictHostKeyChecking=no -o NumberOfPasswordPrompts=1)
command -v sshpass >/dev/null || { echo "需要 sshpass" >&2; exit 1; }
remote() { sshpass -e ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "资源核对（chromium+xvfb 建议 ≥4G 内存）"
remote 'set -e
  MEM_KB=$(awk "/MemTotal/ {print \$2}" /proc/meminfo)
  echo "内存: $((MEM_KB / 1024)) MiB"
  if [ "$MEM_KB" -lt '"$MIN_MEM_KB"' ]; then
    echo "警告：低于 4G，浏览器自动化会抖。升配或接受降级（核心 bash/文件/模型不受影响）。" >&2
  fi'

step "登记远程电脑（owner = 知行人生第一位 admin）并写启动文件（600）"
remote 'set -euo pipefail
  APP_IMAGE="'"$APP_IMAGE"'"
  DB_URL=$(grep "^ZHIXINGBOT_DATABASE_URL=" '"$REMOTE_ZHIXINGBOT_ENV"' | cut -d= -f2-)
  test -n "$DB_URL"
  ADMIN_ROW=$(podman run --rm -v /opt/duowei/data:/data:ro "$APP_IMAGE" \
    node -e "const {createClient}=require(\"@libsql/client\");createClient({url:\"file:/data/duowei.db\"}).execute(\"SELECT id || char(9) || name || char(9) || email FROM users WHERE role=\x27admin\x27 ORDER BY created_at LIMIT 1\").then(r=>{if(!r.rows[0])process.exit(1);console.log(r.rows[0][Object.keys(r.rows[0])[0]])})")
  ADMIN_ID=$(printf "%s" "$ADMIN_ROW" | cut -f1)
  ADMIN_NAME=$(printf "%s" "$ADMIN_ROW" | cut -f2)
  ADMIN_EMAIL=$(printf "%s" "$ADMIN_ROW" | cut -f3)
  test -n "$ADMIN_ID" && test -n "$ADMIN_EMAIL"
  echo "admin: $ADMIN_EMAIL"
  # 白泽库的用户行是首次访问 /assistant 时才 provisioning 的；这里先把知行人生 admin 同步过去
  podman run --rm --network '"$ZHIXINGBOT_NETWORK"' -e DATABASE_URL="$DB_URL" \
    -e ADMIN_ID="$ADMIN_ID" -e ADMIN_NAME="$ADMIN_NAME" -e ADMIN_EMAIL="$ADMIN_EMAIL" "$APP_IMAGE" \
    node --import tsx --input-type=module -e "import { connect, provisionExternalUser } from \"@zhixingbot/control-plane\"; const { db, sql } = connect(process.env.DATABASE_URL, { max: 1 }); await provisionExternalUser(db, { id: process.env.ADMIN_ID, name: process.env.ADMIN_NAME, email: process.env.ADMIN_EMAIL }); await sql.end();"
  ISSUED=$(podman run --rm --network '"$ZHIXINGBOT_NETWORK"' -e DATABASE_URL="$DB_URL" "$APP_IMAGE" \
    ./node_modules/.bin/tsx packages/control-plane/src/scripts/computer-token.ts remote "$ADMIN_EMAIL")
  COMPUTER_ID=$(printf "%s\n" "$ISSUED" | sed -n "s/^COMPUTER_ID=//p")
  AGENT_TOKEN=$(printf "%s\n" "$ISSUED" | sed -n "s/^AGENT_TOKEN=//p")
  test -n "$COMPUTER_ID" && test -n "$AGENT_TOKEN"
  mkdir -p '"$REMOTE_RUN_DIR"' '"$REMOTE_BOTS_DIR"'
  printf "{\"url\":\"%s\",\"computerId\":\"%s\",\"token\":\"%s\",\"dataDir\":\"/home/node/.zhixingbot/bots\"}\n" \
    "'"$AGENT_URL"'" "$COMPUTER_ID" "$AGENT_TOKEN" > '"$REMOTE_RUN_DIR"'/launch.json
  chmod 600 '"$REMOTE_RUN_DIR"'/launch.json
  chown -R 1000:1000 '"$REMOTE_BOTS_DIR"' 2>/dev/null || true
  echo "launch.json 已写好（computer ${COMPUTER_ID}）"'

step "传 bwrap seccomp 配置"
sshpass -e scp "${SSH_OPTS[@]}" "$ROOT/docs/baize/deploy/remote/seccomp-bwrap.json" "$SSH_USER@$HOST:$REMOTE_ZHIXINGBOT_DIR/seccomp-bwrap.json"

step "同步构建上下文到服务器（$REMOTE_SRC_DIR）"
tar czf - -C "$ROOT" \
    package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json patches \
    packages/shared packages/control-plane packages/bot-runner packages/computer-agent \
    packages/desktop/package.json packages/web/package.json packages/e2e/package.json \
    docs/baize/deploy \
  | sshpass -e ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" \
      "rm -rf '$REMOTE_SRC_DIR' && mkdir -p '$REMOTE_SRC_DIR' && tar xzf - -C '$REMOTE_SRC_DIR'"

step "服务器侧构建 zhixingbot-remote 镜像（只在不存在时；chromium 层很重）"
remote 'set -e
  cd '"$REMOTE_SRC_DIR"'
  if podman image exists '"$REMOTE_IMAGE"'; then
    echo "镜像已存在，跳过构建"
  else
    podman build --target remote-computer \
      --build-arg APT_MIRROR='"$APT_MIRROR"' \
      -f docs/baize/deploy/remote/Dockerfile -t '"$REMOTE_IMAGE"' .
    podman image inspect '"$REMOTE_IMAGE"' --format "构建完成：{{.Os}}/{{.Architecture}}"
  fi'

step "（重）起远程电脑容器"
remote 'set -e
  podman rm '"$REMOTE_CONTAINER"' >/dev/null 2>&1 || true
  podman run -d --name '"$REMOTE_CONTAINER"' --restart unless-stopped \
    --network '"$ZHIXINGBOT_NETWORK"' \
    --security-opt seccomp='"$REMOTE_ZHIXINGBOT_DIR"'/seccomp-bwrap.json \
    --security-opt apparmor=unconfined \
    --shm-size 1g --init \
    -v '"$REMOTE_BOTS_DIR"':/home/node/.zhixingbot/bots \
    -v '"$REMOTE_RUN_DIR"':/run/baize \
    '"$REMOTE_IMAGE"' >/dev/null
  podman ps --format "{{.Names}} | {{.Status}}" | grep '"$REMOTE_CONTAINER"' >/dev/null
  echo "容器已起"'

step "冒烟：代理握手 + 电脑在线"
sleep 8
remote 'set -e
  podman logs --tail 8 '"$REMOTE_CONTAINER"' 2>&1 | grep -E "已发 hello|config|online" || { podman logs --tail 20 '"$REMOTE_CONTAINER"'; exit 1; }
  STATUS=$(podman exec zhixingbot-postgres psql -U baize -tAc "SELECT status FROM computers WHERE kind='"'"'remote'"'"'")
  test "$STATUS" = "online"
  echo "远程电脑在线（status=online）"'

echo
echo "完成。Bot 的活现在跑在 zhixingbot-remote 容器里。换 token：重跑本脚本；排障：podman logs -f zhixingbot-remote"
