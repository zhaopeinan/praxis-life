#!/usr/bin/env bash
#
# 知行人生 · 每日值班日报
#
# 汇总：服务健康 / 容器状态 / 磁盘 / 最近备份结果 / 近 24 小时写入与自动化运行，
# 通过飞书机器人推送到群里；任何一项异常都会在文末单独列出。
#
# 运行环境：服务器（需要 curl、sqlite3、podman、df）。
# 配置：/etc/duowei-digest.env 里写 FEISHU_WEBHOOK=...（没配就只写日志不发送）。
# 定时：infra/systemd/duowei-digest.timer（每天 09:30 北京时间）。
set -uo pipefail

DATA_DIR="${DUOWEI_DATA_DIR:-/opt/duowei/data}"
DB="$DATA_DIR/duowei.db"
HEALTH_URL="${DUOWEI_HEALTH_URL:-http://127.0.0.1:8787/api/health}"
PUBLIC_URL="${DUOWEI_PUBLIC_URL:-http://47.122.123.1/}"
ENV_FILE="/etc/duowei-digest.env"
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"

now_ms=$(( $(date +%s) * 1000 ))
since_ms=$(( now_ms - 24 * 60 * 60 * 1000 ))
today="$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')"

issues=()
lines=()

# 1. 服务健康
health="$(curl -s -m 5 "$HEALTH_URL" || true)"
public_code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$PUBLIC_URL" || true)"
if printf '%s' "$health" | grep -q '"ok":true'; then
  lines+=("· 服务：健康（公网 ${public_code}）")
else
  lines+=("· 服务：健康检查失败（公网 ${public_code}）")
  issues+=("服务健康检查失败：${health:-无响应}")
fi
[[ "$public_code" == "200" ]] || issues+=("公网首页返回 ${public_code}，不是 200")

# 2. 容器状态
if command -v podman >/dev/null; then
  status="$(podman inspect duowei --format '{{.State.Status}}' 2>/dev/null || echo 'not-found')"
  image="$(podman inspect duowei --format '{{.ImageName}}' 2>/dev/null || echo '-')"
  started="$(podman inspect duowei --format '{{.State.StartedAt}}' 2>/dev/null | cut -d' ' -f1,2 | cut -d. -f1 || echo '-')"
  if [[ "$status" == "running" ]]; then
    lines+=("· 容器：running（自 ${started}，镜像 ${image##*/}）")
  else
    lines+=("· 容器：${status}")
    issues+=("容器状态 ${status}，不是 running")
  fi
fi

# 3. 磁盘
disk="$(df -h / | awk 'NR==2 {print $5}')"
disk_num="${disk%\%}"
lines+=("· 磁盘：${disk}（/）")
[[ "${disk_num:-0}" -ge 85 ]] && issues+=("磁盘使用率 ${disk}，超过 85%")

# 4. 最近一次备份
if [[ -f "$DB" ]]; then
  backup_row="$(sqlite3 -separator '|' "$DB" "SELECT datetime(started_at/1000,'unixepoch','+8 hours'), status, coalesce(file_name,'') FROM system_backup_logs ORDER BY started_at DESC LIMIT 1;")"
  if [[ -n "$backup_row" ]]; then
    b_time="${backup_row%%|*}"
    rest="${backup_row#*|}"
    b_status="${rest%%|*}"
    b_file="${rest##*|}"
    lines+=("· 备份：${b_time} ${b_status}（${b_file:-无文件}）")
    [[ "$b_status" != "ok" ]] && issues+=("最近一次备份状态是 ${b_status}，不是 ok")
    b_age_h=$(( (now_ms - $(TZ=Asia/Shanghai date -d "$b_time" +%s 2>/dev/null || echo "$(date +%s)") * 1000) / 3600000 ))
    [[ "${b_age_h:-0}" -ge 26 ]] && issues+=("最近一次备份在 ${b_age_h} 小时前，超过 26 小时")
  else
    lines+=("· 备份：还没有任何备份记录")
    issues+=("没有任何备份记录")
  fi

  # 5. 近 24 小时使用量
  new_records="$(sqlite3 "$DB" "SELECT count(*) FROM records WHERE created_at >= $since_ms;")"
  edited_records="$(sqlite3 "$DB" "SELECT count(*) FROM record_history WHERE created_at >= $since_ms;" 2>/dev/null || echo '-')"
  edited_docs="$(sqlite3 "$DB" "SELECT count(*) FROM documents WHERE updated_at >= $since_ms;")"
  auto_runs="$(sqlite3 -separator '|' "$DB" "SELECT status, count(*) FROM automation_runs WHERE created_at >= $since_ms GROUP BY status;" 2>/dev/null | tr '\n' ' ')"
  runs_total=0
  runs_failed=0
  if [[ -n "$auto_runs" ]]; then
    while IFS='|' read -r st n; do
      [[ -z "${st:-}" ]] && continue
      runs_total=$(( runs_total + n ))
      [[ "$st" != "ok" && "$st" != "success" ]] && runs_failed=$(( runs_failed + n ))
    done <<<"$auto_runs"
  fi
  lines+=("· 近 24 小时：新记录 ${new_records} 条、字段变更 ${edited_records} 次、文档更新 ${edited_docs} 篇、自动化运行 ${runs_total} 次（失败 ${runs_failed} 次）")
  [[ "$runs_failed" -gt 0 ]] && issues+=("近 24 小时有 ${runs_failed} 次自动化失败")
else
  lines+=("· 数据：找不到 $DB")
  issues+=("找不到数据库 $DB")
fi

# 组装正文
body="【知行人生值班日报】${today}
$(printf '%s\n' "${lines[@]}")"
if (( ${#issues[@]} > 0 )); then
  body="${body}
需要关注：
$(printf '· %s\n' "${issues[@]}")"
else
  body="${body}
需要关注：无，一切正常。"
fi

echo "$body"

if [[ -n "${FEISHU_WEBHOOK:-}" ]]; then
  payload="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.dumps({"msg_type":"text","content":{"text":sys.stdin.read()}}))' 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    payload="{\"msg_type\":\"text\",\"content\":{\"text\":$(printf '%s' "$body" | awk 'BEGIN{ORS="\\n"}{gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); print}')}}"
  fi
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "$payload" "$FEISHU_WEBHOOK" || true)"
  echo "飞书推送：HTTP ${code}"
  [[ "$code" == "200" ]] || exit 1
else
  echo "未配置 $ENV_FILE 里的 FEISHU_WEBHOOK，本次只输出到日志。"
fi
