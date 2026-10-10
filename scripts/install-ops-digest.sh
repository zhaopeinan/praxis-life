#!/usr/bin/env bash
#
# 在服务器上安装「每日值班日报」：脚本 + systemd timer。
#
# 用法：scripts/install-ops-digest.sh
# 连接信息同样从 aliyun.env 读取。安装后：
#   systemctl list-timers duowei-digest.timer     # 看下次运行时间
#   systemctl start duowei-digest.service         # 立即跑一次（验证）
#   journalctl -u duowei-digest -n 50             # 看日志
#
# 飞书 Webhook 配置在服务器 /etc/duowei-digest.env（FEISHU_WEBHOOK=...），
# 没配置时脚本只写日志不发送。
set -euo pipefail

ROOT="${DUOWEI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
ENV_FILE="$ROOT/aliyun.env"
[[ -f "$ENV_FILE" ]] || { echo "缺少 $ENV_FILE" >&2; exit 1; }

HOST="$(sed -n '2p' "$ENV_FILE" | tr -d '[:space:]')"
SSH_USER="$(sed -n '3p' "$ENV_FILE" | tr -d '[:space:]')"
export SSHPASS="$(sed -n '4p' "$ENV_FILE" | tr -d '\r\n')"
SSH_OPTS=(-o StrictHostKeyChecking=no -o NumberOfPasswordPrompts=1)
command -v sshpass >/dev/null || { echo "需要 sshpass" >&2; exit 1; }

remote() { sshpass -e ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }

echo "==> 上传脚本与 systemd 单元"
sshpass -e scp "${SSH_OPTS[@]}" "$ROOT/scripts/ops-digest.sh" "$SSH_USER@$HOST:/opt/duowei-src/scripts/ops-digest.sh"
sshpass -e scp "${SSH_OPTS[@]}" "$ROOT/infra/systemd/duowei-digest.service" "$SSH_USER@$HOST:/etc/systemd/system/duowei-digest.service"
sshpass -e scp "${SSH_OPTS[@]}" "$ROOT/infra/systemd/duowei-digest.timer" "$SSH_USER@$HOST:/etc/systemd/system/duowei-digest.timer"

echo "==> 启用定时器"
remote 'set -e
chmod +x /opt/duowei-src/scripts/ops-digest.sh
if [[ ! -f /etc/duowei-digest.env ]]; then
  printf "# 飞书机器人 Webhook（群机器人 → 自定义机器人 → 复制 Webhook 地址）\nFEISHU_WEBHOOK=\n" > /etc/duowei-digest.env
  chmod 600 /etc/duowei-digest.env
  echo "已创建 /etc/duowei-digest.env，请填入 FEISHU_WEBHOOK 后立即生效"
fi
systemctl daemon-reload
systemctl enable --now duowei-digest.timer
systemctl list-timers duowei-digest.timer --no-pager | head -3'

echo "==> 立刻试跑一次（不配置 Webhook 时只输出到日志）"
remote 'systemctl start duowei-digest.service; sleep 2; journalctl -u duowei-digest -n 20 --no-pager'

echo
echo "安装完成。"
