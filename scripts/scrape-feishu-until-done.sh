#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
WORKERS="${SCRAPE_WORKERS:-6}"
MAX_ROUNDS="${SCRAPE_ROUNDS:-50}"

count_pending() {
  python3 - <<'PY'
import json
from pathlib import Path
arts = json.loads(Path("docs/feishu-bitable/catalog/articles.json").read_text())
prog = json.loads(Path("docs/feishu-bitable/catalog/progress.json").read_text()) if Path("docs/feishu-bitable/catalog/progress.json").exists() else {}
pending = 0
ok = 0
for a in arts:
    p = prog.get(a["id"], {})
    md = Path("docs/feishu-bitable") / f"articles/{a['title'].replace('/', '-')[:60]}-{a['id']}.md"
    # trust progress markers
    if p.get("ok") and (p.get("textLength") or 0) >= 200:
        ok += 1
    else:
        pending += 1
print(f"{ok} {pending}")
PY
}

round=1
while (( round <= MAX_ROUNDS )); do
  read -r ok pending < <(count_pending)
  echo "=== round $round ok=$ok pending=$pending workers=$WORKERS ==="
  if [[ "$pending" -eq 0 ]]; then
    node --import tsx/esm scripts/build-feishu-index.mts || true
    echo "ALL_DONE ok=$ok"
    exit 0
  fi
  SCRAPE_WORKERS="$WORKERS" node --import tsx/esm scripts/scrape-feishu-bitable-parallel.mts
  code=$?
  echo "round $round exit=$code"
  sleep 2
  round=$((round + 1))
done
echo "gave up after $MAX_ROUNDS rounds"
exit 1
