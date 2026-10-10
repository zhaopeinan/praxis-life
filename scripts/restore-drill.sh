#!/usr/bin/env bash
#
# 备份恢复演练：从坚果云取回最新一份备份，解包并校验，不触碰线上数据。
#
# 用法（在服务器上运行）：
#   scripts/restore-drill.sh                          # 只校验（默认，安全）
#   scripts/restore-drill.sh --restore-to /tmp/duowei  # 额外把备份解包到指定目录
#
# 依赖：curl、sqlite3、tar。坚果云配置（地址 / 账号 / 应用密码 / 远端目录）直接
# 从应用的 SQLite（system_backup_settings 表）读取，不用手抄。
#
# 校验内容：
#   1. 能列出坚果云远端目录并挑出最新一份 zhixing-*.tar.gz
#   2. 压缩包结构完整：duowei.db + pepper（+ uploads/ 附件目录，若产生过）
#   3. SQLite 快照 PRAGMA integrity_check 通过
#   4. 快照里的空间 / 数据表 / 记录 / 文档条数，和当前线上库对比（允许备份比线上旧）
set -euo pipefail

DATA_DIR="${DUOWEI_DATA_DIR:-/opt/duowei/data}"
DB="$DATA_DIR/duowei.db"
RESTORE_TO=""
if [[ "${1:-}" == "--restore-to" ]]; then
  RESTORE_TO="${2:?--restore-to 需要一个目录参数}"
fi

step() { printf '\n==> %s\n' "$1"; }
die() { printf '错误：%s\n' "$1" >&2; exit 1; }

# 与应用一致的百分号编码（encodeURIComponent 语义），逐段编码路径
urlencode() {
  local LC_ALL=C
  printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'
}

encode_path() {
  local encoded="" segment
  while IFS= read -r segment || [[ -n "$segment" ]]; do
    [[ -z "$segment" ]] && continue
    encoded="${encoded:+$encoded/}$(urlencode "$segment")"
  done < <(printf '%s\n' "$1" | tr '/' '\n')
  printf '%s' "$encoded"
}

[[ -f "$DB" ]] || die "找不到 $DB"
command -v sqlite3 >/dev/null || die "缺少 sqlite3"
command -v tar >/dev/null || die "缺少 tar"

step "读取坚果云配置"
DAV_URL="$(sqlite3 "$DB" "SELECT dav_url FROM system_backup_settings WHERE id = 1;")"
USERNAME="$(sqlite3 "$DB" "SELECT username FROM system_backup_settings WHERE id = 1;")"
PASSWORD="$(sqlite3 "$DB" "SELECT password FROM system_backup_settings WHERE id = 1;")"
REMOTE_PATH="$(sqlite3 "$DB" "SELECT remote_path FROM system_backup_settings WHERE id = 1;")"
[[ -n "$USERNAME" && -n "$PASSWORD" ]] || die "备份配置里没有坚果云账号/应用密码"
echo "地址：$DAV_URL"
echo "账号：$USERNAME"
echo "目录：$REMOTE_PATH"

step "列出远端备份"
BASE="${DAV_URL%/}/$(encode_path "$REMOTE_PATH")"
BASE="${BASE%/}"
LIST_XML="$(curl -sS -u "$USERNAME:$PASSWORD" -X PROPFIND -H 'Depth: 1' -H 'Content-Type: application/xml' \
  --data '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/></d:prop></d:propfind>' \
  "$BASE/" 2>&1)" || die "PROPFIND 失败（检查账号或网络）：$LIST_XML"
LATEST="$(printf '%s' "$LIST_XML" | grep -o 'zhixing-[0-9]\{8\}-[0-9]\{6\}\.tar\.gz' | sort -u | sort | tail -1 || true)"
[[ -n "$LATEST" ]] || die "远端目录 $BASE 里没有 zhixing-*.tar.gz（先确认应用备份是否成功）"
echo "最新备份：$LATEST"

WORK="$(mktemp -d /tmp/duowei-drill.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
LOCAL="$WORK/$LATEST"

step "从坚果云下载"
HTTP_CODE="$(curl -sS -u "$USERNAME:$PASSWORD" -o "$LOCAL" -w '%{http_code}' "$BASE/$LATEST")" || die "下载失败"
[[ "$HTTP_CODE" == "200" ]] || die "下载返回 HTTP $HTTP_CODE"
echo "大小：$(du -h "$LOCAL" | cut -f1)"

step "校验压缩包结构"
ENTRIES="$WORK/entries.txt"
tar -tzf "$LOCAL" >"$ENTRIES"
for want in ./duowei.db ./pepper; do
  grep -qx "$want" "$ENTRIES" || die "压缩包缺少 $want"
done
if grep -q '^\./uploads/' "$ENTRIES"; then
  echo "附件目录：包含 uploads/（$(grep -c '^\./uploads/' "$ENTRIES") 个条目）"
else
  echo "附件目录：无（当前线上附件为空目录，属正常）"
fi

step "解包到临时目录并做完整性检查"
tar -xzf "$LOCAL" -C "$WORK"
SNAPSHOT="$WORK/duowei.db"
INTEGRITY="$(sqlite3 "$SNAPSHOT" 'PRAGMA integrity_check;')"
[[ "$INTEGRITY" == "ok" ]] || die "SQLite 完整性检查失败：$INTEGRITY"
echo "SQLite integrity_check：ok"

step "对比快照与线上数据量"
for table in bases tables records documents; do
  SNAP_N="$(sqlite3 "$SNAPSHOT" "SELECT count(*) FROM $table;" 2>/dev/null || echo '?')"
  LIVE_N="$(sqlite3 "$DB" "SELECT count(*) FROM $table;" 2>/dev/null || echo '?')"
  printf '%-10s 快照 %-6s 线上 %-6s\n' "$table" "$SNAP_N" "$LIVE_N"
done

if [[ -n "$RESTORE_TO" ]]; then
  step "按要求解包到 $RESTORE_TO"
  mkdir -p "$RESTORE_TO"
  cp -a "$WORK/." "$RESTORE_TO/"
  rm -f "$RESTORE_TO/entries.txt"
  echo "已恢复（未启动服务）。如需启用到该目录：停容器后把 duowei.db*、pepper、uploads 覆盖回 $DATA_DIR。"
fi

echo
echo "演练结论：通过（备份可下载、结构完整、SQLite 可读）"
