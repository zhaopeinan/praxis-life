# 知行Bot 集成说明（知行人生 × 知行Bot）

知行Bot（多 Bot 协作助理，原独立仓库 SmartStudio/baize-bot）已整体并入本仓库，
作为知行人生的「AI 助理」子系统运行。本文档是合并后的架构与运维手册；
知行Bot自身的设计文档归档在 [docs/baize/](baize/)（含原 CLAUDE.md 约定）。

## 架构一图

```
浏览器  http://47.122.123.1/
  ├── /                知行人生 Web + API（React SPA, SQLite data/duowei.db）
  └── /assistant/      知行Bot Web（React SPA 构建时带前缀）+ 知行Bot API
        │              同一个 Hono 应用、同一个 duowei_session 会话
        ├── /assistant/agent          电脑代理 WebSocket（Bot 运行时通道）
        ├── /assistant/api/ws         浏览器推送 WebSocket
        ├── /assistant/api/live/*     画面接管二进制帧
        └── /assistant/gateway/v1     模型网关（Bot 的 LLM 流量出口）

Podman 容器（阿里云）：
  duowei            合并应用（:8787，--env-file baize.env，挂 baize-net）
  baize-postgres    知行Bot库（PG 16，卷 /opt/duowei/pgdata，宿主 127.0.0.1:5435）
  baize-remote      远程电脑（chromium+xvfb+bwrap，Bot 的活在这跑；独立 setup）
```

账号统一：知行人生会话是唯一登录态。用户首次进 /assistant 时按知行人生用户 id
provisioning 出知行Bot用户行（`provisionExternalUser`），主助理随之自动建好。
知行Bot自带的注册/登录/OAuth 路由在合并模式下全部关闭。

## 本地开发

```bash
pnpm install
docker compose up -d                 # 本机 PG（5434，给知行Bot用；知行人生用 SQLite 不用库）
pnpm dev:full                        # 8787（合并后端，含知行Bot）+ 5174（知行人生 Vite）
# 知行Bot Web 单独调试：BAIZE_BASE=/assistant VITE_BAIZE_BASE=/assistant pnpm --filter @baize/web dev
```

后端起知行Bot要这些环境（写在 .env 里，scripts/dev.mjs 会读）：

```
BAIZE_ENABLED=1
BAIZE_DATABASE_URL=postgres://baize:baize@localhost:5434/baize
BAIZE_TOOL_SECRET_KEY=<openssl rand -hex 32>
BAIZE_CREDENTIALS_KEY=<openssl rand -base64 32>
```

模型上游**不写配置文件**：管理员在知行人生顶栏「模型网关」页填上游地址、API key、
plan/fast 模型名，存进知行人生自己的库（app_settings 表），网关每次请求实时读取
（2 秒缓存），保存后最迟 2 秒生效。不设 BAIZE_ENABLED 时，知行人生行为与合并前完全一致。

## 常用命令

```bash
pnpm check              # typecheck + lint + 全部测试
pnpm -r typecheck       # 知行Bot 7 包各自编译选项下 typecheck
pnpm --filter @baize/control-plane test   # 需要本机 docker PG（每个测试文件临时建库）
pnpm build:web          # 双前端构建（知行Bot Web 自动带 /assistant 前缀）
```

## 生产部署（阿里云）

```bash
scripts/deploy-aliyun.sh              # 应用 + PG + 迁移 + 备份（幂等，可重复跑）
scripts/setup-baize-remote.sh         # 远程电脑容器（Bot 运行时；镜像极重，只构建一次）
```

模型网关在部署后由管理员登录知行人生，在顶栏「模型网关」页填写（上游地址、API key、
plan/fast 模型名），不写配置文件、不用重启。

- 回滚：与旧版相同（`duowei:rollback` 镜像 + 容器参数不变）；知行Bot新增物全是增量，
  回滚到旧镜像时 BAIZE_ENABLED 不在旧 env 里，应用按旧行为跑。
- 备份：SQLite 打包之外，`baize-pg-*.dump`（pg_dump -Fc）落在同一数据目录。
- 资源：chromium+xvfb 建议 ≥4G 内存；setup 脚本低于 4G 会告警。
- Caddy 不用动：/assistant 由合并应用直接伺服，WS Upgrade 默认透传。

### 远程电脑运维

```bash
# 服务器上
podman logs -f baize-remote                    # 代理日志
podman restart baize-remote                    # 重启（launch.json 会被看护进程读后删，重跑 setup 重建）
scripts/setup-baize-remote.sh                  # 换 token / 重建启动文件
```

bwrap 沙箱在容器里要 seccomp 配置（已在 setup 里挂载）；podman 对 apparmor 选项
可能忽略，沙箱行为以日志里 seatbelt/bwrap 探测为准。

## 排障速查

| 现象 | 先看 |
|---|---|
| /assistant 404 | 应用容器 env-file 是否带 BAIZE_ENABLED=1；迁移是否跑过 |
| /assistant/api/* 全 401 | 知行人生会话失效（知行Bot只认 duowei_session） |
| 登录知行人生后 /assistant 白屏 | 镜像里 packages/web/dist 是否存在（build:web 是否跑过） |
| Bot 干活 502 | 知行人生「模型网关」页是否已配上游/key/模型名（保存后 2 秒内生效） |
| 电脑一直离线 | baize-remote 容器状态与日志；launch.json 被读后删是正常行为 |
| 浏览器自动化卡/崩 | 服务器内存；free -m |
