#!/usr/bin/env bash
#
# 部署到阿里云（http://47.122.123.1/，用 IP 直连绕开未备案域名拦截）。
#
# 服务器上是 podman（不是 docker，也没有 compose provider），所以流程是：
#   本机 build linux/amd64 镜像 → save 压缩后经 ssh 管道 podman load
#   → 备份 SQLite → 用同样的启动参数重建容器 → 冒烟检查
#
# 用法：
#   scripts/deploy-aliyun.sh            # 构建 + 部署
#   scripts/deploy-aliyun.sh --no-build # 复用本机已有的 duowei:latest
#
# 连接信息从仓库根的 aliyun.env 读取（该文件已被 .gitignore 忽略），四行依次为：
#   备注 / 主机 / 用户 / 密码
#
# 注意：对外入口是 Caddy 上的 http://47.122.123.1/（明文 HTTP），所以容器用
# DUOWEI_COOKIE_SECURE=0；设为 1 会让浏览器在 HTTP 下不回传会话 Cookie，导致登录后掉线。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/aliyun.env"

IMAGE="duowei:latest"
CONTAINER="duowei"
REMOTE_DATA_DIR="/opt/duowei/data"
PUBLIC_URL="${DUOWEI_PUBLIC_URL:-http://47.122.123.1/}"

BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE（需要 主机/用户/密码 三行）" >&2
  exit 1
fi

HOST="$(sed -n '2p' "$ENV_FILE" | tr -d '[:space:]')"
SSH_USER="$(sed -n '3p' "$ENV_FILE" | tr -d '[:space:]')"
export SSHPASS="$(sed -n '4p' "$ENV_FILE" | tr -d '\r\n')"
SSH_OPTS=(-o StrictHostKeyChecking=no -o NumberOfPasswordPrompts=1)

command -v sshpass >/dev/null || { echo "需要 sshpass：brew install hudochenkov/sshpass/sshpass" >&2; exit 1; }
[[ -n "$HOST" && -n "$SSH_USER" && -n "$SSHPASS" ]] || { echo "aliyun.env 解析失败" >&2; exit 1; }

remote() { sshpass -e ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if (( BUILD )); then
  step "构建 linux/amd64 镜像（服务器是 x86_64，本机多半是 arm64）"
  docker build --platform linux/amd64 --provenance=false --sbom=false -t "$IMAGE" "$ROOT"
fi

step "传输镜像到服务器并 podman load"
docker save "$IMAGE" | gzip -1 | remote 'gunzip -c | podman load'

step "备份线上 SQLite（停容器后一并打包 db / wal / shm）"
remote "podman stop $CONTAINER >/dev/null 2>&1 || true
        sleep 2
        tar czf $REMOTE_DATA_DIR/duowei-db-\$(date +%Y%m%d-%H%M%S).tar.gz -C $REMOTE_DATA_DIR duowei.db duowei.db-wal duowei.db-shm 2>/dev/null || true
        ls -1t $REMOTE_DATA_DIR/duowei-db-*.tar.gz | head -1"

step "确保 Caddy 按 IP 暴露 DuoWei（Host 为裸 IP 时阿里云不拦截）"
remote "bash -s" <<'REMOTE_CADDY'
set -euo pipefail
CADDY=/etc/caddy/Caddyfile
MARK="duowei-ip-entry"
if grep -q "$MARK" "$CADDY"; then
  echo "Caddy IP 站点已存在，跳过"
  exit 0
fi
cp "$CADDY" "$CADDY.bak.$(date +%Y%m%d%H%M%S)"
cat >> "$CADDY" <<'CADDY_BLOCK'

# --- DuoWei · 按 IP 直连入口（duowei-ip-entry）---
# 阿里云只拦 Host / TLS SNI 里未备案的域名；Host 是裸 IP 不会被拦。
# 必须显式 http://，否则 Caddy 会做 80→443 跳转，而 443 对未备案域名会被 RST。
http://47.122.123.1 {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY_BLOCK
caddy validate --config "$CADDY" --adapter caddyfile
systemctl reload caddy
echo "已追加 IP 站点并 reload Caddy"
REMOTE_CADDY

step "用新的 duowei:latest 重建容器"
remote "podman rm $CONTAINER >/dev/null 2>&1 || true
        podman run -d --name $CONTAINER --restart unless-stopped \
          -p 127.0.0.1:8787:8787 \
          -v $REMOTE_DATA_DIR:/app/data \
          -e DUOWEI_HOST=0.0.0.0 \
          -e DUOWEI_PORT=8787 \
          -e DUOWEI_WEB_ROOT=/app/dist-web \
          -e DUOWEI_DEV_CODES=0 \
          -e DUOWEI_COOKIE_SECURE=0 \
          docker.io/library/$IMAGE >/dev/null
        sleep 6
        podman ps --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}' | grep $CONTAINER
        podman logs --tail 5 $CONTAINER"

step "清理历史悬空镜像"
remote "podman image prune -f | tail -1"

step "冒烟检查"
remote "curl -s -o /dev/null -w '容器内 index.html: %{http_code}\n' http://127.0.0.1:8787/
        curl -s http://127.0.0.1:8787/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1"
curl -s -m 20 -o /dev/null -w "公网 $PUBLIC_URL: %{http_code}\n" "$PUBLIC_URL" || echo "（本机访问不了公网域名时可用浏览器自行确认）"

echo
echo "部署完成。数据库备份在服务器 $REMOTE_DATA_DIR/duowei-db-*.tar.gz"
