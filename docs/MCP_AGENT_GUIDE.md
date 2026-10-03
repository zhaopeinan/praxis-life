# DuoWei MCP · Agent 对接手册

> 给 **AI Agent** 阅读：如何通过 MCP 托管 DuoWei（自托管多维表格）。  
> DuoWei **不内置 LLM Agent**；本手册说明「外部 Agent 如何注册并调用 MCP 工具」。

---

## 0. 你是谁、能做什么

你是通过 **MCP stdio** 连接 DuoWei 的工具调用方。身份是管理端登记的 **MCP Agent**（不是人类登录用户）。

**使用前必须：**

1. 向 DuoWei 管理员申请 / 自行调用注册接口  
2. 管理员在「Agent 管理」中**批准**（或直接创建）并分配可访问的多维表格  
3. 拿到令牌 `dwa_…`（在「Agent 管理」列表中可随时查看与复制），配置为 `DUOWEI_TOKEN`

未注册、未批准或已停用的 Agent **无法**启动 MCP。人类个人访问令牌（`dw_…`）**不能**用于 MCP。

**可以：** 在授权范围内读写表、自动化、工作流等（见工具目录）  
**不要：** 臆造 `tableId`；用字段内部 id 代替字段名写记录

---

## 环境（本地 / 部署）

MCP 协议与工具完全相同；换环境只需改 **管理端地址**、**仓库路径 `cwd`**，并在该环境重新登记 Agent、领取 `dwa_…`（令牌不能跨库共用）。

| | 本地开发 | 服务器部署 |
|--|----------|------------|
| 管理端 / Web | http://127.0.0.1:5174/（`npm run dev`） | 部署后的站点根 URL（如 `http://主机/`） |
| REST / 注册 | 同源 `/api/…`，或 http://127.0.0.1:8787/api/… | 同源 `/api/…` |
| 仓库 `cwd` | 本机克隆路径，例如 `/Users/你/…/DuoWei` | 服务器上的代码目录，例如 `/opt/duowei` |
| Agent 令牌 | 在**本地**「Agent 管理」创建或批准后获得 | 在**该服务器**管理端单独创建；与本地库无关 |
| 启动 MCP | 见下方本地示例 | 把 `cwd` 换成服务器路径即可 |

**本地 MCP 配置示例（Cursor / Claude Desktop 等）：**

```json
{
  "mcpServers": {
    "duowei": {
      "command": "npx",
      "args": ["tsx", "src/mcp.ts"],
      "cwd": "/Users/peinan/DevProjects/DuoWei",
      "env": { "DUOWEI_TOKEN": "dwa_你的本地令牌" }
    }
  }
}
```

```bash
cd /Users/peinan/DevProjects/DuoWei
DUOWEI_TOKEN=dwa_… npx tsx src/mcp.ts
```

本地自助注册：`POST http://127.0.0.1:8787/api/mcp-agents/register`（或经 Vite 代理：`http://127.0.0.1:5174/api/mcp-agents/register`）。

---

## 1. 注册与令牌

### 1.1 自助注册（待审批）

```http
POST /api/mcp-agents/register
Content-Type: application/json

{ "name": "Cursor-生产", "description": "研发助手", "contact": "ops@team.com" }
```

返回 `status: "pending"`。等待管理员批准后才会下发令牌。

### 1.2 管理员创建 / 批准

- 界面：登录管理员 → **Agent 管理** →「直接创建并启用」或对申请「批准并发令牌」
- 创建后会直接进入该 Agent 的编辑面板：在这里填写名称 / 联系方式 / 说明，勾选可访问的多维表格并选择角色（viewer / editor / owner）
- 之后随时点列表里该 Agent 的「编辑」就能再调整空间与权限，保存后立即生效
- 令牌在列表里和编辑面板中**随时可查看与复制**；旧版本创建的 Agent 明文已不可找回，在编辑面板点「轮换令牌」重新生成一次即可

### 1.3 MCP 配置

把上一节「环境」里的 `cwd` 与 `DUOWEI_TOKEN` 填进 MCP 客户端即可：

```json
{
  "mcpServers": {
    "duowei": {
      "command": "npx",
      "args": ["tsx", "src/mcp.ts"],
      "cwd": "/绝对路径/到/DuoWei",
      "env": { "DUOWEI_TOKEN": "dwa_你的令牌" }
    }
  }
}
```

```bash
cd /绝对路径/到/DuoWei
DUOWEI_TOKEN=dwa_… npx tsx src/mcp.ts
```

同一令牌也可：`Authorization: Bearer dwa_…` 调 REST（权限与 MCP 相同，受 Agent 表授权约束）。

---

## 2. 每次会话的标准开场

1. `whoami` — 确认 `kind: "agent"`、名称与 id  
2. `get_limits` — 上限  
3. `list_bases` — **仅返回已授权给你的** base / 表  

若 `list_bases` 为空：联系管理员在「Agent 管理」里点你的 Agent「编辑」，勾选可访问的空间。

---

## 3. 权限模型（必读）

### 3.1 Agent 权限

- 系统角色固定为 `member`（即使管理员创建）  
- **可见 base** 仅来自管理端为你勾选的授权（viewer / editor / owner）  
- 未授权的表格：工具会报「没有权限」  
- 不能创建新的多维表格；不能管理人类用户  

### 3.2 人类侧（供对照）

| Base 角色 | 典型能力 |
|-----------|----------|
| `viewer` | 读表、查询 |
| `editor` | 写记录/字段、自动化、审批等 |
| `owner` | 删表、ACL、成员 |

行列 ACL 仍会作用于 Agent 读表结果。

---

## 4. 数据约定（极易踩坑）

### 4.1 Id 与名称

| 对象 | 工具参数 | 说明 |
|------|----------|------|
| base | `baseId` | 来自 `list_bases` |
| table | `tableId` | 来自 `list_bases` 或建表返回 |
| record | `recordId` | 来自 `get_table` / `query_records` |
| field | 多数读写用 **字段名** | `create_record` / `update_record` 的 `fields` 键用字段名 |
| 筛选 | `query_records` 的 `filters[].field` | 字段名或字段 id 均可（名唯一时） |
| document | `documentId` | 来自 `list_documents` / `create_document` |
| folder | `parentId` | 文件夹也是文档记录，`kind: "folder"`，可作 `parentId` |

### 4.2 单元格值

- **单选**：传选项 **名称**（如 `"进行中"`），不是选项内部 id
- **多选**：字符串数组或工具接受的列表形式
- **日期**：`YYYY-MM-DD`
- **人员**：显示名/约定文本（按表内人员字段习惯）
- **附件**：先 `upload_file`，把返回的 meta/url 写入附件字段
- **公式 / 系统字段 / 按钮**：一般不可直接 `update_record`

### 4.3 筛选运算符（`query_records`）

`eq` | `neq` | `contains` | `not_contains` | `gt` | `gte` | `lt` | `lte` | `is_empty` | `is_not_empty`

示例：查「任务」表状态为进行中：

```json
{
  "tableId": "t_xxx",
  "filters": [{ "field": "状态", "op": "eq", "value": "进行中" }],
  "limit": 50
}
```

### 4.4 自动化 schedule DSL

`create_automation` / `update_automation` 触发 `type: "schedule"` 时，`cron` 支持：

| 写法 | 含义 |
|------|------|
| `every:5` | 每 5 分钟 |
| `hourly` | 每小时 |
| `daily:09:00` | 每天 9:00（本机时区） |
| `weekly:1:09:00` | 周一 9:00（`0=周日 … 6=周六`） |
| `0 9 * * *` | 类 cron：分 时（仅分钟/小时匹配） |

定时由服务端 `runDueSchedules` 轮询；也可 admin 调 `run_due_automations` 立刻扫一轮。

---

## 5. 推荐工作流（菜谱）

### 5.0 个人待办 + 日历 + 飞书

1. `create_base_from_template`，`template: "todos"`（个人待办）或 `"research"`（科研管理：论文 / 任务 / 投稿记录）；也可在界面「从模板新建」  
2. `set_base_settings` 写 `integrations.feishuWebhookUrl`（飞书群自定义机器人）  
3. `send_feishu` 测通；`send_feishu_digest` 推近到期待办  
4. `create_calendar_feed` 拿到 `token`，订阅：`{站点}/api/calendar/{token}.ics`（苹果日历 / Google / 飞书日历均可）  
5. 日常：`create_record` / `update_record` 改「状态」「截止日期」；模板已带「新建通知飞书」和「每天 09:00 摘要」

飞书 Webhook 须是 `https://open.feishu.cn/open-apis/bot/v2/hook/…`（或 larksuite.com）。文本可用 `{标题}`、`{截止日期}` 等字段名。

### 5.1 查数并改状态

1. `list_bases` → 找到表  
2. `query_records` 筛选  
3. `update_record` 改字段  
4. 需要留痕 → `add_comment`

### 5.2 从零建一套业务表

1. `create_base` 或 `create_base_from_template`（`requirements` / `engineering`）  
2. `create_table`（可带 `fields`、`withKanban: true`）  
3. `create_field` / `create_view`  
4. `create_record` 灌数据  
5. （可选）`share_base` 拉成员  

### 5.3 每日汇总写日报（Agent 编排，非产品内置）

1. `query_records`：源表 `状态=进行中`  
2. `create_record`：写入「日报」表（字段名按实际表结构）  
3. `add_comment`：在日报记录上写说明  

若要用产品定时能力：建 `schedule` 自动化 + 动作；Agent 也可用调度器定时自己调 MCP。

### 5.4 审批

1. `list_workflows` / `create_workflow`（nodes 含 trigger + approval/action）  
2. `list_workflow_runs` / `get_workflow_run`  
3. `decide_workflow_run`（approve/reject）  
4. 需要时：`transfer_workflow_run` / `add_sign_workflow_run`  
5. 运维：`get_workflow_sla`；admin：`process_workflow_timeouts`  
6. 代理：`set_approval_proxy` / `list_approval_proxies`

### 5.5 公开只读视图 / 表单

1. `create_public_share`（`kind`: `view` | `form`）  
2. `set_public_share_enabled` / `delete_public_share`  
3. 单记录链接：`create_record_share`（完整 token 只返回一次）

### 5.6 实验前思考 / 实验后复盘（文档 + 挂靠记录）

1. `list_bases` → `get_table` 找到实验记录所属的表与 `recordId`
2. `create_document`：`template: "experiment-plan"`，写入「要回答的问题 / 假设 / 变量设计 / 判据」
3. `link_document_record`：把这篇文档挂到该记录，`label: "实验前思考"`
4. 实验跑完后 `create_document`：`template: "experiment-review"` 建复盘，`link_document_record` 挂同一条记录，`label: "实验复盘"`
5. 追加结论时：先 `get_document` 拿全文，拼接后 `update_document` 整篇写回（不是追加）
6. 复查改了什么：`list_document_revisions`；写坏了 `restore_document_revision` 回滚
7. 人类在界面里看到的：侧边栏「文档」下的文档树，以及记录详情页的「相关文档」面板

---

## 6. 工具目录（按域）

共 **108** 个工具。名称即 MCP tool name。

### 6.1 身份与发现

| 工具 | 用途 |
|------|------|
| `whoami` | 当前用户 |
| `get_limits` | 上限 |
| `list_bases` | 可见 base + tables |
| `list_templates` | 模板列表 |

### 6.2 Base / 表 / 字段 / 记录 / 视图

| 工具 | 用途 | 最低角色（约） |
|------|------|----------------|
| `create_base` / `rename_base` / `delete_base` | base CRUD | rename/delete: owner |
| `create_base_from_template` | 模板建 base | — |
| `get_table` / `query_records` | 读/筛 | viewer |
| `create_table` / `rename_table` / `delete_table` | 表 | delete: owner |
| `create_field` / `update_field` / `delete_field` | 字段 | editor |
| `list_field_change_targets` / `change_field_type` | 改类型 | editor |
| `create_record` / `update_record` / `delete_record` | 记录 | editor |
| `create_view` / `update_view` / `delete_view` / `set_view_protection` | 视图 | editor |
| `export_csv` / `import_csv` | CSV | 读/写对应 |
| `get_detail_page` / `set_detail_page` | 详情页布局 | viewer / editor |
| `get_base_settings` / `set_base_settings` | 时区/门户 | viewer / owner |

**视图类型与参数对应**（`create_view` 的 `type`）：

| type | 中文 | 必须带的参数 | 说明 |
|------|------|--------------|------|
| `grid` | 表格 | — | 默认视图，无需额外参数 |
| `kanban` | 看板 | `groupField` | 按该单选字段分列；没单选字段时分不了组 |
| `calendar` | 日历 | `dateField` | 按该日期字段铺到月历 |
| `gantt` | 甘特 | `dateField` | 同上，需要起止跨度时用带区间的日期 |
| `gallery` | 画册 | `titleField` | 卡片标题取该字段，适合带附件/封面的表 |
| `form` | 表单 | — | 对外填单入口，配合 `create_public_share` 分享 |

`create_table` 的 `withKanban: true` 会在建表时自动按第一个单选字段补一个看板视图，等价于建表后自己调一次 `create_view`。

### 6.3 评论 / 历史 / 关注 / 通知

| 工具 | 用途 |
|------|------|
| `list_comments` / `add_comment` / `delete_comment` | 评论 |
| `list_record_history` | 变更历史 |
| `watch_record` / `unwatch_record` / `is_watching_record` / `list_watched_records` | 关注 |
| `list_notifications` / `mark_notification_read` | 通知 |

### 6.4 成员与 ACL

| 工具 | 用途 |
|------|------|
| `list_members` / `share_base` / `remove_member` | 成员 |
| `get_acl` / `set_acl` / `preview_acl` | 行列权限（owner） |

### 6.5 自动化

| 工具 | 用途 |
|------|------|
| `list_automations` / `create_automation` / `update_automation` / `delete_automation` | CRUD |
| `run_due_automations` | 扫定时（**admin**） |
| `click_button` | 点按钮字段（触发按钮自动化） |

触发类型：`record_created` | `record_updated` | `field_equals` | `button` | `webhook` | `schedule`  
动作类型：`set_field` | `create_record` | `add_comment` | `notify` | `http_request` | `send_email`

### 6.6 工作流与审批

| 工具 | 用途 |
|------|------|
| `list_workflows` / `create_workflow` / `update_workflow` / `delete_workflow` | 定义 |
| `list_workflow_runs` / `get_workflow_run` | 运行实例 |
| `decide_workflow_run` / `transfer_workflow_run` / `add_sign_workflow_run` | 审批动作 |
| `list_workflow_audit` | 审计 |
| `get_workflow_sla` / `process_workflow_timeouts` | SLA / 超时（超时处理需 admin） |
| `list_approval_proxies` / `set_approval_proxy` / `clear_approval_proxy` | 代理 |

### 6.7 仪表盘与分享

| 工具 | 用途 |
|------|------|
| `list_dashboards` / `create_dashboard` / `get_dashboard` / `update_dashboard` | 仪表盘（`get_dashboard` 可带 slicers） |
| `list_public_shares` / `create_public_share` / `set_public_share_enabled` / `delete_public_share` | 公开分享 |
| `create_record_share` / `get_shared_record` | 单记录分享 |

### 6.8 同步 / 插件 / 附件

| 工具 | 用途 |
|------|------|
| `list_sync_jobs` / `create_sync_job` / `update_sync_job` / `run_sync_job` / `delete_sync_job` | 表间同步 |
| `list_plugin_hooks` / `create_plugin_hook` / `update_plugin_hook` / `delete_plugin_hook` | 钩子（写操作多需 admin） |
| `list_marketplace_plugins` / `set_marketplace_plugin` | 市场插件 |
| `upload_file` / `get_upload_meta` / `delete_upload` | 附件（上传为 base64，≤8MB） |

### 6.9 文档（Markdown 长文）

DuoWei 的「文档」是挂在多维表格下的 **Markdown 长文**，和表数据平级但独立存储：适合写**实验前思考**、**实验后复盘**、**研究笔记**这类没有固定字段结构的长文本。正文支持表格、代码块、数学公式（KaTeX）与 Mermaid 图。

文档也可以**挂靠到记录**上：一条实验记录可以同时挂「实验前思考」和「实验后复盘」两篇，靠 `label` 区分；记录详情页的「相关文档」面板显示的就是这组挂靠关系。

| 工具 | 用途 | 最低角色 |
|------|------|----------|
| `list_document_templates` | 三个内置模板的标题与正文骨架 | — |
| `list_documents` | 列出 base 下的文档与文件夹（不含正文，含 `parentId` / `kind` / `bodyLength` / `linkCount`） | viewer |
| `get_document` | 读取正文 `bodyMd` 与已挂靠记录 `links` | viewer |
| `create_document` | 新建文档或文件夹，可套模板 | editor |
| `update_document` | 改标题或正文（改动自动归档历史版本） | editor |
| `move_document` | 归到别的文件夹或根目录 | editor |
| `delete_document` | 删除（文件夹会连同子文档一起删） | editor |
| `list_document_revisions` | 历史版本（倒序，默认 50 版） | viewer |
| `restore_document_revision` | 回滚到某一版 | editor |
| `link_document_record` | 把文档挂到记录上（可带 `label`） | editor |
| `unlink_document_record` | 解除挂靠 | editor |
| `list_record_documents` | 某条记录关联的文档 | viewer |

内置模板（`create_document` 的 `template`）：

| template | 名称 | 内容骨架 |
|----------|------|----------|
| `experiment-plan` | 实验前思考 | 要回答的问题、假设、变量与设计、成功判据、风险与备选 |
| `experiment-review` | 实验后复盘 | 结论、关键数据、意外与偏差、原因分析、下一步 |
| `research-note` | 研究笔记 | 研究笔记的通用骨架 |

**几个容易踩的点：**

- 文档的权限沿用所在 **base 的角色**，没有独立的文档权限；未授权的 base 下的文档工具会直接报「没有权限」。
- `update_document` 的 `bodyMd` 是**整篇替换**，不是追加。要在原有内容后补一段，得先 `get_document` 拿到全文，拼接后再整篇写回。
- 每次内容变动都会把**改动前**的版本归档一份（每篇最多保留 50 版），所以改坏了可以用 `list_document_revisions` + `restore_document_revision` 找回。
- 文件夹本身也是一条文档记录（`kind: "folder"`），只是正文不展示；只有文件夹能作为 `parentId`，文档不能嵌套文档。
- 跨 base 移动会被拒绝。

---

## 7. Agent 行为准则

1. **先发现再写入**：`list_bases` → `get_table` 确认字段名与选项，再 `create/update_record`。  
2. **小步验证**：写入后用 `query_records` 或 `get_table` 核对。  
3. **尊重权限**：失败信息直接展示，不要伪造成功。  
4. **危险操作二次确认**（若你的宿主支持）：`delete_base` / `delete_table` / `delete_record` / `delete_field`。  
5. **大批量**：无批量工具；循环单条调用，注意限速与上限。  
6. **附件**：用 `upload_file`，不要假设本地路径可被服务器读取。  
7. **分享 token**：`create_record_share` / `create_public_share` 返回的完整 token 只出现一次，需交给用户保存。  
8. **不要**试图通过 MCP「创建 LLM 智能体」；用工具完成任务即可。

---

## 8. 快速自检清单

- [ ] `whoami` 成功且身份符合预期  
- [ ] `list_bases` 能看到目标业务表  
- [ ] `query_records` 能按字段名筛到数据  
- [ ] `create_record` + `update_record` 可用字段名写入  
- [ ] （可选）`list_documents` + `create_document` 能建文档，`link_document_record` 能挂到记录  
- [ ] （可选）`create_automation` schedule 或审批流程跑通  

---

## 9. 故障排查

| 现象 | 处理 |
|------|------|
| MCP 进程立刻退出 | 检查是否为 **dwa_** Agent 令牌且状态为已启用；cwd、依赖；个人 dw_ 令牌不可用 |
| list_bases 为空 | 管理员尚未授权任何多维表格 |
| 找不到表/字段 | 重新 list_bases / get_table；是否越权访问未授权 base |
| 单选写入无效 | 改用选项 **名称**，与表内选项完全一致 |
| 权限错误 | 检查 base 成员角色；ACL 是否挡住行/列 |
| 定时自动化不跑 | 确认服务进程在跑且 schedule tick 开启；admin 可调 `run_due_automations` |
| 附件失败 | base64 是否合法；是否超过 8MB |

---

## 10. 给宿主 Agent 的一句话提示词（可粘贴）

```text
你通过 MCP 服务「duowei」操作 DuoWei 多维表格。
身份是已注册的 MCP Agent（令牌 dwa_…），不是人类用户。
开始时先 whoami → get_limits → list_bases（仅含已授权表格）。
读写记录一律使用字段名；单选传选项名称；日期用 YYYY-MM-DD。
改数据前先 get_table / query_records 确认结构。
写长文（实验前思考、复盘、研究笔记）用 create_document 套模板（experiment-plan / experiment-review / research-note），再用 link_document_record 挂到对应记录；update_document 的正文是整篇替换，不是追加。
若 list_bases 为空或没有权限，请提示用户去 DuoWei「Agent 管理」授权。
删除类操作先说明影响再执行。
```

---

*工具列表以运行中的 MCP / `src/mcp-catalog.ts` 为准；本手册与 DuoWei 仓库同步维护。*
