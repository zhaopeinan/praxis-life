# zhaopeinan.com DNS 迁移到 Cloudflare（含 Named Tunnel）

> ⚠️ **本文已作废（历史记录）。** 2026-10-07 服务已**迁回阿里云**：域名走 Cloudflare 的方案不再使用，
> 全部服务改回武汉 ECS `47.122.123.1` 直连。该域名**未备案**，阿里云边缘按 Host / TLS SNI 拦截域名，
> 因此 **Agent 与人类都改用 IP 直连访问**（DuoWei 为 `http://47.122.123.1/`；headscale 为
> `http://47.122.123.1:8443`）。下面记录的是已回滚的 Cloudflare 迁移过程，仅供排障参考，不要再照做。

> 目的（历史）：把 `task.zhaopeinan.com` 等域名恢复成**固定的公网 HTTPS 地址**。
> 现状：域名 NS 在阿里云万网（`dns17/dns18.hichina.com`），所有服务域名 A 记录直连武汉 ECS
> `47.122.123.1`，域名**未备案**，阿里云边缘对未备案域名做拦截（HTTP 403 / HTTPS TLS 握手重置），
> 所以这些域名目前从公网**完全不可用**。

---

## 〇、迁移进度（2026-10-06 全部完成）

| 阶段 | 状态 | 说明 |
|--|--|--|
| A. Cloudflare 建 zone | **已完成** | zone 已创建（Free 套餐），记录已逐条核对补齐到 16 条 |
| B. 切换 NS | **已完成** | 阿里云「修改DNS」已提交并通过手机短信验证，公共解析器已全部返回 Cloudflare IP |
| C. 服务器建隧道 | **已完成** | Named Tunnel `duowei` 已创建并跑在 systemd 上，8 个域名 CNAME 已切到隧道 |
| D. 验证 | **已完成** | 8 个域名经 Cloudflare 边缘全部返回正确内容；`task` API 健康检查通过 |

**关键标识（后续排障要用）：**

| 项 | 值 |
|--|--|
| Cloudflare Account ID | `e976c7cea6d7456e9515f63d93015cfb` |
| Cloudflare Zone ID | `34c8a143724d49e6a1585c0ed6fdac99` |
| Tunnel 名称 | `duowei` |
| Tunnel UUID | `a5f607be-910f-4a7e-8cd6-b8c58ff12f5e` |
| Tunnel CNAME 目标 | `a5f607be-910f-4a7e-8cd6-b8c58ff12f5e.cfargotunnel.com` |
| 服务端配置文件 | `/etc/cloudflared/config.yml` |
| 服务端凭据文件 | `/root/.cloudflared/a5f607be-910f-4a7e-8cd6-b8c58ff12f5e.json` |
| systemd 单元 | `cloudflared.service`（已 enable，开机自启） |

**Cloudflare 分配的 NS（已确认）：**

- `mina.ns.cloudflare.com`
- `moura.ns.cloudflare.com`

**其他已核查项：**

- 阿里云 DNSSEC 设置：无 DS 记录，即 DNSSEC 处于关闭状态，切 NS 不会因 DS 不匹配导致解析失败。
- Cloudflare 扫描只识别出 10 条记录（缺 `task`/`hs`/`hs-admin`/`me`/`changzheng` 五条 A 与
  `_dnsauth.nas`），已手动补全，现 zone 内共 16 条，与第二节清单一致。
- `nas` 在 Cloudflare 扫描结果里默认是「Proxied」，已手动改为 **DNS only**（灰云），
  否则这台非 HTTP 用途的机器（`123.120.4.247`）会因走 Cloudflare 代理而无法直连。
- 指向 `47.122.123.1` 的 8 条 A 记录已全部替换为隧道 CNAME（橙云）。

### 实施过程中的意外与处理

1. **`cloudflared tunnel login` 走不通。** 授权页面点击 Authorize 后返回
   `POST /api/v4/user/tokens` → `400 {"code":1211,"message":"Please verify your email."}`。
   即该 Cloudflare 账号（`zhaopeinan@163.com`）的邮箱验证状态不满足签发 token 的条件，
   导致拿不到 `cert.pem`。
   **绕过办法**：改用「已登录控制台的浏览器会话」直接调 Cloudflare v4 API 建隧道——
   在已登录 `dash.cloudflare.com` 的标签页里执行 `page.fetch()`，
   调用 `POST /api/v4/accounts/{account_id}/cfd_tunnel`，
   响应里同时返回 `credentials_file`（写入服务器即可）和 `token`。
   **副作用**：邮箱未验证这件事会在其他地方继续弹（比如新建 API Token），
   建议以后有空把 `zhaopeinan@163.com` 的 Cloudflare 验证邮件点掉。

2. **控制台点 Authorize 反复弹回。** 见上，是同一个 `1211` 导致的重试。

### SSL/TLS 设置（已调整）

- SSL/TLS 加密模式：从默认的 **Full** 改为 **Full (strict)**。
  因为源站 Caddy 持有真实 Let's Encrypt 证书（8 个域名各一张，acme-v02 目录下），
  strict 可以校验源站证书，避免中间人。
- **Always Use HTTPS**：已开启（HTTP 80 → 301 → HTTPS）。

### 最终 DNS 记录（16 条）

| 类型 | 主机记录 | 代理 | 记录值 |
|--|--|--|--|
| CNAME | `@` | 橙云 | `<TUNNEL-UUID>.cfargotunnel.com` |
| CNAME | `www` | 橙云 | 同上 |
| CNAME | `me` | 橙云 | 同上 |
| CNAME | `task` | 橙云 | 同上 |
| CNAME | `stats` | 橙云 | 同上 |
| CNAME | `hs` | 橙云 | 同上 |
| CNAME | `hs-admin` | 橙云 | 同上 |
| CNAME | `changzheng` | 橙云 | 同上 |
| A | `nas` | **灰云** | `123.120.4.247` |
| TXT | `@`（SPF） | — | `v=spf1 include:spf.163.com ~all` |
| TXT | `_acme-challenge` ×2 | — | 历史遗留，可删 |
| TXT | `_dnsauth` ×3 + `_dnsauth.nas` ×1 | — | 历史遗留，可删 |

### 隧道 ingress 设计

一条隧道覆盖全部 8 个域名，**统一回源到 `https://127.0.0.1:443`（Caddy）**，
用每条规则的 `originRequest.originServerName` 指定 SNI，让 Caddy 按域名选中对应站点块。

这样做的原因：Caddy 已持有全部域名的真实证书，并承担了静态文件服务、
自定义 404、gzip、`hs-admin` 的安全响应头等职责；让隧道直连各上游端口
（8787 / 8080 / 18765 / 3000）会丢掉这些行为，还要额外给静态站找一个 HTTP 服务器。
经 Caddy 的代价只是 localhost 上多一跳，可忽略。

`originServerName` 必须逐条指定：cloudflared 默认用回源 URL 的 host（即 `127.0.0.1`）做 SNI，
不指定的话 Caddy 匹配不到站点块。

### 验证结果（2026-10-06）

经 Cloudflare 边缘 IP（`104.21.79.83`）实测：

| 域名 | 结果 |
|--|--|
| `zhaopeinan.com` | 200，个人站首页 |
| `www.zhaopeinan.com` | 200，同上 |
| `me.zhaopeinan.com` | 200，个人主页 |
| `changzheng.zhaopeinan.com` | 200，长征静态站 |
| `task.zhaopeinan.com` | 200，DuoWei 前端；`/api/health` → `{"ok":true}` |
| `stats.zhaopeinan.com` | 200，Umami 面板 |
| `hs.zhaopeinan.com` | 200，headscale；`/health` → 200，`/derp` → 426（预期，等待 upgrade） |
| `hs-admin.zhaopeinan.com` | 303 → `/login`（预期），且 `permissions-policy` / `x-frame-options` / `referrer-policy` 等响应头保留 |

其他确认项：

- 不存在的路径 → 404（Caddy 自定义 404 页生效）。
- HTTP → HTTPS：301 跳转。
- DNS 里已无任何指向 `47.122.123.1` 的 A 记录，阿里云的 SNI 拦截已无从触发。
- 隧道状态 `healthy`，4 条出站连接。

### 遗留事项与风险

1. **本机 stub 解析器缓存**：`114.114.114.114` 仍缓存着旧的 `47.122.123.1` 若干分钟
   （各记录 TTL 不同，会先后过期）。公共解析器（`1.1.1.1`/`8.8.8.8`/`223.5.5.5`）已全部返回 Cloudflare IP。
   只是本机短期现象，无需处理。
2. **~~UDP STUN 走不了隧道~~ —— 2026-10-06 实测证伪，无需处理，也不需要灰云记录。**

   原文的判断依赖一个不成立的前提：以为 STUN 用的是域名、会解析到 Cloudflare 的代理 IP。
   实际上 Tailscale 客户端做 IPv4 STUN 探测时，直接用 DERP map 里的 `IPv4` 字面量，
   **完全不做 DNS 解析**（tailscale 源码 `net/netcheck/netcheck.go` 的 `nodeAddrPort()`：
   `case probeIPv4: if n.IPv4 != "" { return netip.AddrPortFrom(ip, port), true }`）。
   本机的 DERP map 里 `IPv4: 47.122.123.1` 已由 `derp.server.ipv4` 填好，
   所以 STUN 报文走的是 `47.122.123.1:3478/udp` 直连，从头到尾不经过 Cloudflare。
   DERP map 里的 `HostName: hs.zhaopeinan.com` 只在**没有** IPv4/IPv6 时才会被解析，本场景用不到。

   **结论：STUN 正常，打洞探测正常，不需要为 UDP 另建灰云 A 记录，也不需要改 DERP 通告地址。**
   实测证据见「七、STUN / DERP 实际路径实测」。

3. **`cloudflared-quick.service` 已彻底移除**（2026-10-06 复查）。
   单元文件、`multi-user.target.wants` 软链、运行中进程都不存在；
   `systemctl list-unit-files` 里只剩 `cloudflared.service`。无需再处理。
4. **Cloudflare 免费版没有大陆节点**，境内访问会绕到香港/新加坡/洛杉矶等边缘，
   延迟比原「直连武汉」高约 100–300ms。
5. **合规**：域名未备案而对外提供服务的性质没有改变，Cloudflare 只让域名在网络层不出现。
6. **只有一个 STUN 服务器 → `MappingVariesByDestIP` 判定不可靠。**
   netcheck 判定「NAT 映射是否随目的地址变化」，靠的是比较**两个不同目的 IP** 回送的
   XOR-MAPPED-ADDRESS（`net/netcheck/netcheck.go` 的 `addNodeLatency()`：第二次观测值与首次
   `gotEP4` 不同才置 `true`，相同则置 `false`）。DERP map 里只有我们这一个节点，
   两次探测打的是同一个目的 IP，观测到的映射必然相同，于是**恒定得出 `false`**。
   若某个节点的 NAT 其实是对称型（symmetric），这个 `false` 就是误判：
   magicsock 会把对该目的地址无效的 endpoint 通告给对端，白试一轮才退回 DERP，
   而且对称型 NAT 的「端口猜测」策略也不会启用。修法见第七节末尾，本次未做。
7. **DERP 实际是直连 `47.122.123.1:443`，不是走 Cloudflare 隧道。**
   原文「DERP 本身经 443 隧道是通的」表述不准确。实测 Caddy 的 443 上有来自客户端公网 IP 的
   已建立连接，说明 derphttp 是按 DERP map 里的 `IPv4` 直连的。
   直连之所以能通，是因为那层拦截是按「HTTP 语义」做启发式的：同样 SNI 下 `curl` 被 RST，
   但 `openssl s_client` 能完整握手并拿到真实 Let's Encrypt 证书，DERP 这种长连接二进制流也被放行。
   也就是说 DERP 能用是「恰好吃不到拦截」，不是有保证；若拦截策略收紧，DERP 会先挂而 STUN 不受影响。

---

## 七、STUN / DERP 实际路径实测（2026-10-06）

### 服务端事实

- `ss -ulnp` → headscale 独占 `*:3478`（UDP），监听全地址。
- headscale 启动日志 `derp nodes[0]`：
  `HostName:hs.zhaopeinan.com IPv4:47.122.123.1 IPv6: STUNPort:3478 STUNOnly:false DERPPort:443`
  与客户端 `tailscale debug derp-map` 拿到的完全一致（无 IPv6 字段）。
- `tcpdump -i any -n -vv udp port 3478` 抓到来自 `106.9.73.47`、`183.242.199.133`
  两个客户端公网 IP 的 STUN Binding Request（40 字节），服务器随即回 44 字节 Binding Success Response，往返成立。
- `47.122.123.1` 是 EIP（`meta-data/eipv4` 返回它），不会随实例重启漂移。

### 客户端事实

- `tailscale netcheck`：
  - `UDP: true`
  - `IPv4: yes, 106.9.73.47:55870`
    —— 这个 `IP:port` 就是 STUN 服务端回送的 XOR-MAPPED-ADDRESS，直接证明往返成功、打洞探测没失败。
  - `MappingVariesByDestIP: false`（另一次运行为空，见遗留事项 6）
  - `DERP latency: aliyun 73–115ms`
- `tailscale debug break-derp-conns` 之后，headscale 指标
  `http_requests_total{endpoint="GET /derp",proto="HTTP/1.1",status="200"}` 从 8 → 9，
  证明 DERP 连接能被打断后重新建立（即 DERP 可用）。
- 服务器 `ss -tn` 显示 Caddy 443 上有来自 `106.9.73.47`、`183.242.199.133` 的 ESTABLISHED 连接，
  即 DERP 走直连 `47.122.123.1:443`。
- `tailscale ping desktop-c1lghs2` → 直连（非中继），IPv6 端点，36–40ms。

### 结论

| 项 | 状态 | 走哪条路 |
|--|--|--|
| STUN（UDP 3478） | 正常 | 直连 EIP，不经 Cloudflare |
| DERP 中继 | 正常 | 直连 EIP:443（不是隧道） |
| 节点间直连/打洞 | 正常 | 直连 |

### 关于「灰云记录」方案的结论

不必做。灰云 A 记录只在客户端**按域名**去解析 STUN 地址时才有意义，
而 Tailscale 客户端在 `IPv4` 已填的情况下根本不会去解析域名。
真要改善打洞，正确的方向不是加灰云记录，而是**增加第二个「不同 IP」的 STUN 端点**
（解决遗留事项 6 的 `MappingVariesByDestIP` 误判）。两种做法：

1. `derp.urls` 里加上 `https://controlplane.tailscale.com/derpmap/default`：
   一次拿到 20+ 个不同 IP 的 STUN 端点，netcheck 判定立刻准确；代价是这些公共 DERP
   同时成为可用的中继节点（极端情况下数据可能经 Tailscale 的服务器中转，与原配置
   「仅用自建嵌入式 DERP，不走公共中继」的取舍冲突）。
2. 用 `derp.paths` 挂一个自写的 DERP map 覆盖文件，只加 1–2 个 `STUNOnly: true` 的节点
   （例如指向 `stun.cloudflare.com:3478`、`stun.l.google.com:19302`）：
   同样能拿到不同目的 IP 的观测值，但**不会**引入额外中继能力，更贴合原设计取舍。


---

## 一、前置条件核查结果（2026-10-06）

| 检查项 | 结果 | 结论 |
|--|--|--|
| 域名状态 | 正常 | 通过 |
| 持有者实名认证 | 实名认证成功 | 通过 |
| 注册局安全锁 | 未开启 | 通过 |
| 注册时间 | 2016-12-07 | 远超 ICANN 60 天锁定期，通过 |
| 到期时间 | 2028-12-07 | 无需立即续费 |
| 注册商 | Alibaba Cloud Computing (Beijing) Co., Ltd. | — |
| 当前 DNS | dns17.hichina.com / dns18.hichina.com | 可修改 |

**结论：可以改 NS 到 Cloudflare。**

---

## 二、现有解析记录全量清单（共 16 条）

| 类型 | 主机记录 | 记录值 | 说明 |
|--|--|--|--|
| A | `@` | 47.122.123.1 | 个人站主域 |
| A | `www` | 47.122.123.1 | 个人站 |
| A | `task` | 47.122.123.1 | DuoWei API |
| A | `stats` | 47.122.123.1 | 统计（umami） |
| A | `hs` | 47.122.123.1 | headscale |
| A | `hs-admin` | 47.122.123.1 | headscale 管理端 |
| A | `me` | 47.122.123.1 | 个人主页 |
| A | `changzheng` | 47.122.123.1 | 长征 |
| A | `nas` | **123.120.4.247** | **另一台机器，非阿里云，不要改成隧道** |
| TXT | `@` | `v=spf1 include:spf.163.com ~all` | 邮件 SPF |
| TXT | `_acme-challenge` | `Btw_LFX-bby4yUgcimEpZAvNuwy4rNdX4EwKe7LJv7E` | 证书验证（可丢弃） |
| TXT | `_acme-challenge.www` | `Ff8LHLhbSy05nGmwJeRjvSQJ8i3w1N8wXQkkID-hNZM` | 证书验证（可丢弃） |
| TXT | `_dnsauth` | `202602270000002g1mrx4u94qcv52a434v4b4fpgx6t2kqjkz23dsmrd0aae7qdr` | 阿里云证书 DNS 验证 |
| TXT | `_dnsauth` | `202409040000000k6ejgdbpeyn7q8lt713lboqmt1ahedq4xbgbnyipt3i7daeq2` | 同上 |
| TXT | `_dnsauth` | `202004200000003pvr1npj3254opc6hvq6xnwt4zh1w2sihyxj1dhzq2spc2zysn` | 同上 |
| TXT | `_dnsauth.nas` | `202308280000005fyuhbud2ksrvb740nqhcqimwzpmsxrymujhh4uxehzy7aosk0` | 同上 |

备注：
- `zhaopeinan.com` **没有 MX 记录**，但有一条指向 `spf.163.com` 的 SPF。也就是说这个域名的
  收信其实没有落地；联系人邮箱用的是 `zhaopeinan@163.com`，与域名本身无关。迁移时 SPF 可原样保留。
- 三条同名 `_dnsauth` TXT 是历史遗留的证书验证记录，功能上已无意义，迁移时可只保留最新一条或全部丢弃。

---

## 三、迁移后的目标设计

关键点：**任何 A 记录只要还指向 `47.122.123.1`，无论开不开 Cloudflare 代理都会被阿里云拦截**
（橙云时代理回源带 SNI 被重置，灰云时客户端直连带 SNI 被重置）。
所以必须全部走 **Cloudflare Named Tunnel**（隧道由服务器主动出站连 Cloudflare）。

| 域名 | 迁移后 | 方式 |
|--|--|--|
| `task` / `stats` / `hs` / `hs-admin` / `me` / `changzheng` / `@` / `www` | CNAME → `<TUNNEL-UUID>.cfargotunnel.com` | Named Tunnel（橙云） |
| `nas` | A `123.120.4.247` | 保持原样，DNS only（灰云） |
| `@` TXT SPF | 原样复制 | — |
| `_dnsauth*` / `_acme-challenge*` | 原样复制或丢弃 | — |

一条隧道覆盖全部服务，`~/.cloudflared/config.yml` 用 ingress 规则分发到各本地端口。

---

## 四、操作步骤

### 阶段 A：在 Cloudflare 建好 zone（不动 NS）

1. Cloudflare 控制台 → Add a site → `zhaopeinan.com` → Free 套餐。
2. Cloudflare 会自动扫描导入解析记录。**逐条与本文档第二节的 16 条比对，补齐缺失项。**
   特别确认 `nas` 和三条 TXT 有没有被漏掉。
3. 记下 Cloudflare 分配的两个 NS（形如 `xxx.ns.cloudflare.com`）。

### 阶段 B：切换 NS

4. 阿里云域名控制台 → `zhaopeinan.com` → 基本信息 → DNS 服务器旁的「**修改DNS**」。
5. 填入 Cloudflare 的两个 NS，确认提交。
6. 等待生效：`dig NS zhaopeinan.com` 直到返回 Cloudflare 的 NS，控制台 zone 状态变为 Active。
   通常几分钟到几小时，注册局缓存最长 24–48 小时。
7. 生效后 Cloudflare 自动签发 Universal SSL（覆盖 `zhaopeinan.com` 与一层 `*.zhaopeinan.com`）。

### 阶段 C：服务器上建 Named Tunnel

8. `cloudflared tunnel login`（无头服务器：把输出的 URL 复制到本地浏览器授权 `zhaopeinan.com`）。
9. `cloudflared tunnel create duowei`，记录 UUID 与 `~/.cloudflared/<uuid>.json`。
10. 为每个域名建路由：`cloudflared tunnel route dns duowei <域名>`。
11. 写 `~/.cloudflared/config.yml`，一条隧道覆盖全部服务（各 service 指向对应本地端口）。
12. `cloudflared service install` → `systemctl enable --now cloudflared`。
13. 关掉原来的 quick tunnel 服务（`cloudflared-quick`），避免两条隧道同时跑。

### 阶段 D：验证

14. 本机 `curl` 各域名，确认 200 且内容正确。
15. 用境内手机 4G 实测延迟与稳定性。

---

## 五、风险与注意事项

- **切 NS 后阿里云云解析立即失效**，域名下所有记录改由 Cloudflare 负责。所以阶段 A 的记录核对必须先做完。
- **传播窗口期**：部分解析器仍指向阿里云、部分指向 Cloudflare，若记录没对齐会出现部分用户访问异常。
- **备案状态与 NS 无关**，改 NS 不会影响备案信息，但这个域名本来就没备案。
- **合规提醒**：大陆服务器上的站点通过隧道对外提供且未备案，仍不符合备案要求，存在被阿里云处置的风险。
  Cloudflare 只让域名在网络层不出现，不等于合规。
- **境内访问质量**：免费版 Cloudflare 没有大陆节点，境内用户会被调度到香港/新加坡/洛杉矶等海外边缘，
  链路由「大陆 → 武汉」变为「大陆 → 海外 CF 边缘 → 隧道 → 武汉」，延迟通常增加约 100–300ms，
  晚间跨境拥堵时抖动更明显。可接受但不理想。

---

## 六、替代方案

- **办 ICP 备案**：域名直连即通，境内访问质量最好。周期长，是长期最省事的解。
- **香港/新加坡小 VPS 自建反代（frp/nginx）**：不动 NS，可自选线路，境内延迟通常明显好于免费 CF。
