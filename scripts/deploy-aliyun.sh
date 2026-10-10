#!/usr/bin/env bash
#
# 部署到阿里云（http://47.122.123.1/，用 IP 直连绕开未备案域名拦截）。
#
# 服务器上是 podman（不是 docker，也没有 compose provider），默认流程是：
#   本机 build linux/amd64 镜像 → save 压缩后经 ssh 管道 podman load
#   → 备份 SQLite → 用同样的启动参数重建容器 → 冒烟检查
#
# 用法：
#   scripts/deploy-aliyun.sh              # 本机构建 + 部署
#   scripts/deploy-aliyun.sh --no-build   # 复用本机已有的 duowei:latest
#   scripts/deploy-aliyun.sh --remote-build
#       不在本机建镜像：本机只 `npm run build:web`，然后把源码 + dist-web 传上去，
#       在服务器（本来就是 x86_64）上原生 podman build。没有跨架构模拟，快很多；
#       本机装不了 buildx / 跑不了 amd64 模拟时也用这个。
#
# 部署带冒烟与回滚：上线前把当前镜像打成 duowei:rollback，冒烟（健康检查 + 首页 200 +
# 前端资源可取到）不通过就自动切回上一版并重建容器。Caddy 配置以仓库
# infra/caddy/duowei.caddyfile 为准，服务器上的内联块会被清理并换成 import。
#
# 连接信息从仓库根的 aliyun.env 读取（该文件已被 .gitignore 忽略），四行依次为：
#   备注 / 主机 / 用户 / 密码
#
# 注意：对外入口是 Caddy 上的 http://47.122.123.1/（明文 HTTP），所以容器用
# DUOWEI_COOKIE_SECURE=0；设为 1 会让浏览器在 HTTP 下不回传会话 Cookie，导致登录后掉线。
#
set -euo pipefail

ROOT="${DUOWEI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
ENV_FILE="$ROOT/aliyun.env"

IMAGE="duowei:latest"
# 本机 docker 侧的标签；服务器 podman 侧统一用这个全名，两条构建路径（本机 load / 服务器 build）
# 都收敛到同一个标签，避免 podman 把新镜像存成 localhost/… 而 run 时又用到旧的 docker.io/library/…。
RUN_IMAGE="docker.io/library/duowei:latest"
# 上一版镜像的标签：每次部署前把当前线上镜像打到这里，冒烟失败就切回来。
ROLLBACK_IMAGE="docker.io/library/duowei:rollback"
CONTAINER="duowei"
REMOTE_DATA_DIR="/opt/duowei/data"
REMOTE_SRC_DIR="/opt/duowei-src"
# 国内服务器直连 Docker Hub 不通，基础镜像走镜像加速站。
NODE_BASE="${DUOWEI_NODE_BASE:-docker.m.daocloud.io/library/node:22-bookworm-slim}"
PUBLIC_URL="${DUOWEI_PUBLIC_URL:-http://47.122.123.1/}"

BUILD=1
REMOTE_BUILD=0
[[ "${1:-}" == "--no-build" ]] && BUILD=0
[[ "${1:-}" == "--remote-build" ]] && REMOTE_BUILD=1

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

# 起容器的命令（正式部署与回滚共用，避免两处漂移）
container_run_cmd() {
  cat <<EOF
podman rm $CONTAINER >/dev/null 2>&1 || true
podman run -d --name $CONTAINER --restart unless-stopped \\
  -p 127.0.0.1:8787:8787 \\
  -v $REMOTE_DATA_DIR:/app/data \\
  -e DUOWEI_HOST=0.0.0.0 \\
  -e DUOWEI_PORT=8787 \\
  -e DUOWEI_WEB_ROOT=/app/dist-web \\
  -e DUOWEI_DEV_CODES=0 \\
  -e DUOWEI_COOKIE_SECURE=0 \\
  $RUN_IMAGE >/dev/null
sleep 6
EOF
}

# 冒烟：健康检查 + 首页 200 + 首页引用的前端资源能取到 + 关键只读接口
smoke_check() {
  remote 'set -e
    curl -fsS -m 10 http://127.0.0.1:8787/api/health | grep -q "\"ok\":true"
    test "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/)" = "200"
    ASSET="$(curl -s http://127.0.0.1:8787/ | grep -o "assets/index-[A-Za-z0-9_-]*\.js" | head -1)"
    test -n "$ASSET"
    curl -fsS -o /dev/null "http://127.0.0.1:8787/$ASSET"
    echo "冒烟通过（健康检查 / 首页 / 前端资源）"'
}

rollback_to_previous() {
  step "冒烟失败：回滚到上一版镜像"
  remote "set -e
          podman tag $ROLLBACK_IMAGE $RUN_IMAGE
          $(container_run_cmd)
          podman ps --format '{{.Names}} | {{.Image}} | {{.Status}}' | grep $CONTAINER"
  if smoke_check; then
    echo "已回滚到上一版镜像，服务正常。请检查本次改动。" >&2
  else
    echo "回滚后冒烟仍失败，需要人工介入。" >&2
  fi
  exit 1
}

step "记住当前线上镜像为回滚点（$ROLLBACK_IMAGE）"
# 必须在任何构建/传输动作之前：--remote-build 会在服务器上直接把 $RUN_IMAGE 覆盖成新镜像，
# 放到后面就会把新镜像当成回滚点。
remote "if podman image exists $RUN_IMAGE; then
          podman tag $RUN_IMAGE $ROLLBACK_IMAGE
          podman image inspect $ROLLBACK_IMAGE --format '回滚点已保存：{{.Id}}'
        else
          echo '线上还没有镜像，跳过保存回滚点'
        fi"

if (( REMOTE_BUILD )); then
  step "本机构建前端产物（原生 arm64，产物与平台无关）"
  (cd "$ROOT" && npm run build:web)

  step "上传源码 + dist-web，并在服务器上原生构建镜像"
  # 先在服务器上停掉 duowei：一是给 podman build 腾内存（该机器只有 1.7G 且无 swap），
  # 二是备份步骤本来也要停容器。
  # 刻意不带仓库根的 .dockerignore：它把 dist-web 排除在外（对根 Dockerfile 正确，因为前端是在镜像内构建的），
  # 而 Dockerfile.remote 正要 COPY dist-web。上下文由下面这份白名单控制，本来也不会带上 node_modules / data / .git。
  # scripts / infra 也要带上：/opt/duowei-src 会被清空重建，值班日报、恢复演练脚本以这里为落点。
  tar czf - -C "$ROOT" \
      Dockerfile.remote package.json package-lock.json tsconfig.json \
      src web dist-web scripts infra \
    | remote "set -e
             rm -rf $REMOTE_SRC_DIR && mkdir -p $REMOTE_SRC_DIR
             tar xzf - -C $REMOTE_SRC_DIR
             cd $REMOTE_SRC_DIR
             podman stop $CONTAINER >/dev/null 2>&1 || true
             podman build --build-arg NODE_BASE=$NODE_BASE -f Dockerfile.remote -t $RUN_IMAGE .
             podman image inspect $RUN_IMAGE --format '构建完成：{{.Os}}/{{.Architecture}}'"
elif (( BUILD )); then
  step "构建 linux/amd64 镜像（服务器是 x86_64，本机多半是 arm64；平台已在 Dockerfile 的 FROM 上声明）"
  # buildx 是独立插件进程，在受限/沙箱环境里可能连不上 docker socket（报 permission denied），
  # 此时回退到 CLI 内置的 legacy builder。注意 `docker buildx ls` 即便连不上 daemon 也返回 0，
  # 所以只能先真跑再回退。
  if ! docker build --provenance=false --sbom=false -t "$IMAGE" "$ROOT"; then
    echo "提示：buildx 构建失败，回退到 DOCKER_BUILDKIT=0（走模拟执行，较慢）" >&2
    DOCKER_BUILDKIT=0 docker build -t "$IMAGE" "$ROOT"
  fi

  # legacy builder 在 arm64 上会忽略 FROM 里的平台声明，静默产出 arm64 镜像。宁可在这里失败，
  # 也不要把跑不起来的镜像推上服务器。
  ARCH="$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')"
  if [[ "$ARCH" != "linux/amd64" ]]; then
    echo "构建产物的平台是 $ARCH，不是 linux/amd64，服务器（x86_64）跑不了。" >&2
    echo "改用：scripts/deploy-aliyun.sh --remote-build" >&2
    exit 1
  fi
fi

if (( REMOTE_BUILD )); then
  step "跳过镜像传输（镜像已在服务器上构建）"
else
  step "传输镜像到服务器并 podman load"
  docker save "$IMAGE" | gzip -1 | remote 'gunzip -c | podman load'
fi

step "备份线上 SQLite（停容器后一并打包 db / wal / shm）"
remote "podman stop $CONTAINER >/dev/null 2>&1 || true
        sleep 2
        tar czf $REMOTE_DATA_DIR/duowei-db-\$(date +%Y%m%d-%H%M%S).tar.gz -C $REMOTE_DATA_DIR duowei.db duowei.db-wal duowei.db-shm 2>/dev/null || true
        ls -1t $REMOTE_DATA_DIR/duowei-db-*.tar.gz | head -1"

step "同步 Caddy 配置（仓库 infra/caddy/duowei.caddyfile 为准）"
sshpass -e scp "${SSH_OPTS[@]}" "$ROOT/infra/caddy/duowei.caddyfile" "$SSH_USER@$HOST:/etc/caddy/duowei.caddyfile"
remote 'set -euo pipefail
CADDY=/etc/caddy/Caddyfile
if ! grep -q "^import /etc/caddy/duowei.caddyfile" "$CADDY"; then
  cp "$CADDY" "$CADDY.bak.$(date +%Y%m%d%H%M%S)"
  # 清掉早期脚本直接追加的内联块（标记行到该块结束的 "}" 为止），改为 import
  awk '"'"'
    index($0, "duowei-ip-entry") { skip = 1; next }
    skip && $0 == "}" { skip = 0; next }
    skip { next }
    { print }
  '"'"' "$CADDY" > "$CADDY.tmp"
  mv "$CADDY.tmp" "$CADDY"
  printf "\nimport /etc/caddy/duowei.caddyfile\n" >> "$CADDY"
  echo "已清理旧内联块并加入 import"
else
  echo "已存在 import，仅更新被 import 的文件"
fi
caddy validate --config "$CADDY" --adapter caddyfile
systemctl reload caddy
# 配置文件已入仓，历史手工备份只保留最近 2 份
ls -1t /etc/caddy/Caddyfile.bak.* 2>/dev/null | tail -n +3 | xargs -r rm -f
echo "Caddy 已按仓库配置重载"'

step "用新的 duowei:latest 重建容器"
remote "$(container_run_cmd)
        podman ps --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}' | grep $CONTAINER
        podman logs --tail 5 $CONTAINER"

step "冒烟检查（失败自动回滚到 $ROLLBACK_IMAGE）"
smoke_check || rollback_to_previous
curl -s -m 20 -o /dev/null -w "公网 $PUBLIC_URL: %{http_code}\n" "$PUBLIC_URL" || echo "（本机访问不了公网地址时可用浏览器自行确认）"

step "清理历史悬空镜像"
remote "podman image prune -f | tail -1"

echo
echo "部署完成。上一版镜像保留为 $ROLLBACK_IMAGE，数据库备份在服务器 $REMOTE_DATA_DIR/duowei-db-*.tar.gz"
