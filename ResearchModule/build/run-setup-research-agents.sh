#!/usr/bin/env bash
# 一次性：临时管理员令牌 → 创建/更新科研站内智能体 → 删除临时令牌。
# 依赖：本机 node、sshpass、aliyun.env；远端 podman + sqlite3。
#
# 注意：宿主机 sqlite3 写入后，运行中的 DuoWei 进程可能读不到新行（WAL/连接缓存），
# 因此插入令牌后会 restart 容器再跑 setup。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/aliyun.env"
HOST="$(sed -n '2p' "$ENV_FILE" | tr -d '[:space:]\r')"
SSH_USER="$(sed -n '3p' "$ENV_FILE" | tr -d '[:space:]\r')"
export SSHPASS="$(sed -n '4p' "$ENV_FILE" | tr -d '\r\n')"
SSH=(sshpass -e ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST")

mkdir -p data
node <<'NODE'
const { createHash, randomBytes } = require("crypto");
const fs = require("fs");
const token = `dw_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
const id = `p_${randomBytes(6).toString("hex")}`;
fs.writeFileSync("data/.duowei-admin-setup.json", JSON.stringify({
  token, hash, id, prefix: token.slice(0, 10), now: Date.now(),
}));
console.log("minted token id=" + id);
NODE

# 在容器内用 libsql 写入，与应用同客户端；再 restart 确保进程读到
TOKEN_JSON="$(python3 -c "import json; print(json.dumps(json.load(open('data/.duowei-admin-setup.json'))))")"
"${SSH[@]}" "TOKEN_JSON=$(printf %q "$TOKEN_JSON") podman exec -e TOKEN_JSON -w /app duowei node --import tsx --input-type=module -e '
import { createClient } from \"@libsql/client\";
const m = JSON.parse(process.env.TOKEN_JSON);
const db = createClient({ url: \"file:/app/data/duowei.db\" });
await db.execute(\"PRAGMA journal_mode = WAL\");
await db.execute({ sql: \"DELETE FROM access_tokens WHERE name = ?\", args: [\"research-agent-setup\"] });
await db.execute({
  sql: \"INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)\",
  args: [m.id, \"u_6cc277fd0814\", \"research-agent-setup\", m.hash, m.prefix, m.now],
});
console.log(\"inserted\", m.id);
'"
"${SSH[@]}" "podman restart duowei >/dev/null"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null -H "Authorization: Bearer $(python3 -c "import json; print(json.load(open('data/.duowei-admin-setup.json'))['token'])")" \
    "http://47.122.123.1/api/auth/me"; then
    echo "auth ok after ${i}s"
    break
  fi
  sleep 1
done

GATEWAY="$("${SSH[@]}" "sqlite3 /opt/duowei/data/duowei.db \"SELECT value FROM app_settings WHERE key='model_gateway';\"")"
printf '%s\n' "$GATEWAY" > data/.duowei-gateway.json

python3 <<'PY'
import json
g = json.load(open("data/.duowei-gateway.json"))
m = json.load(open("data/.duowei-admin-setup.json"))
base = g["upstreamBaseUrl"].rstrip("/")
if not base.endswith("/v1"):
  base = base + "/v1"
open("data/.duowei-agent-env", "w").write(
  "\n".join([
    "export DUOWEI_BASE_URL=http://47.122.123.1",
    f"export DUOWEI_ADMIN_TOKEN={m['token']}",
    f"export DUOWEI_LLM_BASE_URL={base}",
    f"export DUOWEI_LLM_MODEL={g['planModel']}",
    f"export DUOWEI_LLM_API_KEY={g['apiKey']}",
    "",
  ])
)
print("gateway model=", g["planModel"], "base=", base)
PY

# shellcheck disable=SC1091
source data/.duowei-agent-env
npx tsx ResearchModule/build/setup-research-agents.mts

TOKEN_ID="$(python3 -c "import json; print(json.load(open('data/.duowei-admin-setup.json'))['id'])")"
"${SSH[@]}" "TOKEN_ID=$TOKEN_ID podman exec -e TOKEN_ID -w /app duowei node --import tsx --input-type=module -e '
import { createClient } from \"@libsql/client\";
const db = createClient({ url: \"file:/app/data/duowei.db\" });
await db.execute({ sql: \"DELETE FROM access_tokens WHERE id = ?\", args: [process.env.TOKEN_ID] });
console.log(\"deleted\", process.env.TOKEN_ID);
'"
rm -f data/.duowei-admin-setup.json data/.duowei-gateway.json data/.duowei-agent-env
echo "cleanup done"
