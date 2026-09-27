#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
BATCH="${1:-30}"
for ((start=0; start<244; start+=BATCH)); do
  echo "=== batch start=$start ==="
  node --import tsx/esm scripts/scrape-feishu-bitable.mts "$start" "$BATCH" || true
  node --import tsx/esm scripts/build-feishu-index.mts || true
done
echo "all batches done"
