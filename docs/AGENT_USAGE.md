# 知行人生 · Agent 使用说明

你正在协助用户使用「知行人生」——一套自托管的人生管理工具（空间 / 清单 / 看板 / 日历）。
请用 HTTP 调用其 REST API；不要臆造 tableId / recordId，先 list 再写。

## 接入信息

- **API 根地址**：`http://47.122.123.1`
- **务必用这个 IP 直连地址**：服务部署在国内云主机，用域名会被云厂商按未备案域名拦截（HTTP 403 / TLS 握手被重置）。不要把它替换成任何域名。
- **鉴权头**：`Authorization: Bearer <令牌>`
- 令牌类型：
  - `dwa_…`：MCP Agent 令牌（管理员在网页「Agent 管理」创建/批准后获得，可随时在列表中查看与复制）
  - `dw_…`：个人访问令牌（网页「访问令牌」创建；仅 REST）
- 所有请求 `Content-Type: application/json`（有 body 时）
- 健康检查（无需登录）：`GET http://47.122.123.1/api/health` → `{"ok":true}`

## 每次会话开场（必做）

1. `GET http://47.122.123.1/api/auth/me` — 确认身份
2. `GET http://47.122.123.1/api/bases` — 列出可见「空间」，每个空间**已经带上它下面的「清单」**：`tables: [{ id, name }]`。没有 `GET /api/bases/{baseId}` 这个接口，需要空间里的表就读这一步的返回
3. 选定 `tableId` 后：`GET http://47.122.123.1/api/tables/{tableId}` — 字段（`fields[].id` / `name` / `type`）与记录
4. 需要筛选：`POST http://47.122.123.1/api/tables/{tableId}/query`，body 示例：

```json
{
  "filters": [{ "fieldId": "fld_xxx", "op": "eq", "value": "进行中" }],
  "conjunction": "and",
  "sorts": [{ "fieldId": "fld_yyy", "direction": "desc" }],
  "limit": 50
}
```

- **筛选 / 排序用字段 id（`fieldId`）**，取自第 3 步 `fields[].id`；写记录时才用字段名（见下）
- 可用运算符：`eq` `neq` `contains` `not_contains` `gt` `gte` `lt` `lte` `is_empty` `is_not_empty`

5. （可选）空间内的文档：`GET http://47.122.123.1/api/bases/{baseId}/documents`，可加 `?q=关键词`

**若 `/api/bases` 为空**：请用户在「Agent 管理」中点开你的 Agent「编辑」，勾选可访问的空间。

## 产品语义 ↔ API

| 界面用语 | API | 说明 |
|----------|-----|------|
| 空间 | base（`baseId`） | 顶层容器，包含多个清单 |
| 清单 / 数据表 | table（`tableId`） | 空间内的数据表 |
| 记录 | record（`recordId`） | 表内的一行数据 |
| 字段 | field | 写记录时用**字段名**作 JSON 键；筛选 / 排序用 `fields[].id`（`fieldId`） |
| 视图 | view | 同一张表的不同展现方式（表格/看板/日历/甘特等） |
| 文档 | document | 空间内的 Markdown 文档 |

## 写数据约定（极易踩坑）

- `POST /api/tables/{tableId}/records` 创建记录；`PATCH /api/records/{recordId}` 更新记录
- body 形如：
```json
{
  "fields": {
    "标题": "…",
    "状态": "进行中",
    "截止日期": "2026-10-01"
  }
}
```
- **单选字段**：传选项**名称**（如 `"进行中"`），不是选项内部 id
- **多选字段**：字符串数组，如 `["标签 1", "标签 2"]`
- **日期字段**：`YYYY-MM-DD` 格式
- **只读字段，写入会被忽略或直接报错**：`formula`（公式）、`lookup`（引用）、`button`（按钮）、`auto_number`、`created_time`、`updated_time`、`created_by`；创建记录时这些字段被静默忽略，更新记录时会报「系统字段，不可直接修改」
- 删除记录：`DELETE /api/records/{recordId}`
- 写记录用**字段名**作 JSON 键；筛选 / 排序用 `fieldId`，两者不要混

## 常用能力

### 模板建空间

```bash
POST http://47.122.123.1/api/templates/{id}
```

可用模板：
- `todos` — 个人待办（看板 + 日历 + 飞书摘要）
- `research` — 科研管理（论文 / 任务 / 投稿）
- `requirements` — 需求管理
- `engineering` — 研发进度

### 新建清单

```bash
POST http://47.122.123.1/api/bases/{baseId}/tables
```

body：`{ "name": "本周任务", "fields": [{ "name": "标题", "type": "text" }, { "name": "状态", "type": "single_select", "options": ["待开始", "进行中", "已完成"] }], "withKanban": true }`
（`fields` 可省略，`options` 也可以用 `{ "name": "进行中", "color": "blue" }`）

### 新建字段

```bash
POST http://47.122.123.1/api/tables/{tableId}/fields
```

body：`{ "name": "负责人", "type": "person" }`；`type` 取字段类型表里的值（如 `text` / `number` / `date` / `single_select` / `multi_select` / `person` / `attachment` / `formula`）

### 新建视图

```bash
POST http://47.122.123.1/api/tables/{tableId}/views
```

body：`{ "name": "看板", "type": "kanban", "groupField": "状态" }` —— 这里传**字段名**（`groupField` / `dateField` / `titleField` / `endDateField` / `progressField`），服务端会解析成对应字段

### 文档（Markdown 长文）

```bash
GET   http://47.122.123.1/api/bases/{baseId}/documents      # 列表；加 ?q=关键词 搜索标题与正文
POST  http://47.122.123.1/api/bases/{baseId}/documents      # 新建：{ "title": "…", "bodyMd": "# …" }（kind 可选 "doc" / "folder"）
GET   http://47.122.123.1/api/documents/{documentId}        # 详情：bodyMd 正文 + links[] 关联记录
PATCH http://47.122.123.1/api/documents/{documentId}        # 更新：{ "title"?, "bodyMd"?, "icon"? }
```

- 文档与记录的关联不在正文里做标记，而是接口返回的 `links[]`，每项含 `recordId` / `tableId` / `label` / `recordTitle`
- 新增关联：`POST http://47.122.123.1/api/documents/{documentId}/records`，body `{ "recordId": "…" }`

### 评论

```bash
POST http://47.122.123.1/api/records/{recordId}/comments
```

### 导出 CSV

```bash
GET http://47.122.123.1/api/tables/{tableId}/export.csv
```

（同样需要带 `Authorization: Bearer <令牌>`）

### 导出整个空间（Zip）

```bash
GET http://47.122.123.1/api/bases/{baseId}/export.zip
```

（同样需要带 `Authorization: Bearer <令牌>`）一个 zip 包住整个空间：每张表的 `tables/*.json`（字段、视图、全部记录）与 `tables/*.csv`（表格快照）、文档正文 `documents/*.md`、记录与文档引用到的附件原件 `attachments/`，外加 `manifest.json`（清单与统计）与 `README.md`（包结构说明）。附件缺失或单表超过 5000 条会写进 manifest 的 `missingAttachments` / `truncated` 字段。

### 飞书集成

在空间设置里配置飞书机器人 Webhook 后：

- `POST http://47.122.123.1/api/bases/{baseId}/feishu-test` — 测试连接（可传 `{ "text": "…", "webhookUrl": "…" }` 覆盖默认配置）
- `POST http://47.122.123.1/api/tables/{tableId}/feishu-digest` — 发送摘要（可传 `{ "daysAhead": 7, "dateField": "截止日期", "excludeStatuses": ["已完成"] }`）

## 推荐工作流示例

### 查并进行中的待办并勾掉一条

1. `GET /api/bases` → 找到「个人待办」空间下的待办表 `tableId`
2. `GET /api/tables/{tableId}` → 取「状态」字段的 `fields[].id`
3. `POST /api/tables/{tableId}/query`，`{ "filters": [{ "fieldId": "<状态字段 id>", "op": "eq", "value": "进行中" }] }`（值用表内实际选项名）
4. `PATCH /api/records/{recordId}`，`{ "fields": { "状态": "已完成" } }`

### 从模板开一套科研管理

1. `POST /api/templates/research`
2. `GET /api/bases` 确认新空间，拿到「论文」「任务」「投稿记录」三张表的 `tableId`
3. 按字段名往三张表写记录；「任务」的「所属论文」是关联字段，值要传论文记录的 `recordId` 数组，如 `[{ "fields": { "标题": "精读 baseline", "所属论文": ["rec_xxx"] } }]`

### 在文档中查找并打开关联记录

1. `GET /api/bases` 找到目标空间（`baseId`）
2. `GET /api/bases/{baseId}/documents`（可加 `?q=关键词`）找到目标文档 `documentId`
3. `GET /api/documents/{documentId}` → 读 `bodyMd` 正文与 `links[]`（关联记录带 `recordId` / `tableId` / `recordTitle`）
4. `GET /api/tables/{tableId}` 或用 `POST /api/tables/{tableId}/query` 取记录的当前值
5. 如需编辑：`PATCH /api/records/{recordId}`

## 权限提醒

- Agent 只能看到管理员授权给它的空间
- 看某空间的协作者：`GET /api/bases/{baseId}/members`（返回 `userId` / `name` / `email` / `role`）
- 删空间 / 部分管理接口需要更高角色；失败时阅读返回 JSON 的 `error` 字段，不要重试硬闯
- 不要把令牌写进公开仓库或聊天记录；用户若只给了占位符，先请用户粘贴真实 `dwa_` / `dw_` 令牌

## 给 Cursor / Codex / WorkBuddy 等的用法

把**本说明全文**贴进对话，并补上真实令牌。然后直接下任务，例如：

- 「列出我所有空间和清单」
- 「把科研管理里截稿在本周的论文列出来」
- 「在个人待办新建一条：本周五前提交周报」
- 「打开文档《项目规划》，找到关联的需求记录并更新状态」

你应优先用 REST 完成任务，并在关键操作后用简短中文向用户汇报结果。

## 常见错误处理

| 错误 | 原因 | 处理方式 |
|------|------|----------|
| `401 Unauthorized` | 没带令牌或令牌无效 | 检查 `Authorization: Bearer <令牌>` 头；令牌前缀应为 `dwa_` / `dw_` |
| `403 Forbidden` | 已登录但没权限（空间未授权给该 Agent） | 请用户在「Agent 管理」里点开该 Agent「编辑」，勾选这个空间 |
| `400 Bad Request` | 请求体不合法：字段名写错、筛选用了字段名而不是 `fieldId`、日期格式不对、漏了 `fields` 外层… | 读返回 JSON 的 `error` 字段按提示改 |
| `404 Not Found` | baseId / tableId / recordId 不存在，或不在可见范围内 | 重新 `GET /api/bases` 或 `GET /api/tables/{tableId}` 取正确 ID |
| `Agent 不能创建多维表格，请在管理端授权已有表格` | 用 Agent 令牌建空间 / 用模板建空间 | 改用个人令牌（dw_）或在网页端手动创建 |
| `Connection reset by peer` | 用了域名而非 IP | 改用 `http://47.122.123.1` 裸 IP 访问 |

## 视图类型说明

| 视图类型 | type | 配置要点 |
|----------|------|----------|
| 表格 | `grid` | 支持分组、筛选、排序、填色规则 |
| 看板 | `kanban` | 需要一个单选字段分组（建视图时传 `groupField`，存为 `groupFieldId`） |
| 日历 | `calendar` | 需要一个日期字段（建视图时传 `dateField`，存为 `dateFieldId`） |
| 甘特图 | `gantt` | 需要开始日期字段（`dateField`），可选结束日期 / 进度字段（`endDateField` / `progressField`） |
| 画册 | `gallery` | 需要标题字段（`titleField`），其余字段在卡片上展示 |
| 表单 | `form` | 只展示可填写字段，用于快速录入 |

## 字段类型说明

| 字段类型 | type | 写入格式 |
|----------|------|----------|
| 文本 | `text` / `long_text` | 字符串 |
| 数字 | `number` / `currency` / `rating` / `progress` | 数字（`rating` 0–上限，`progress` 0–100） |
| 日期 | `date` | `"YYYY-MM-DD"` |
| 单选 | `single_select` | 选项名称字符串 |
| 多选 | `multi_select` | 选项名称数组 |
| 复选框 | `checkbox` | `true` / `false` |
| 邮箱 / 电话 / 链接 | `email` / `phone` / `url` | 字符串（前两者会校验格式） |
| 人员 / 群组 | `person` / `group` | **姓名**，单个字符串或用逗号分隔 / 数组（不是 user id） |
| 关联 | `link` | 关联记录的 `recordId` 数组（记录须属于该字段绑定的那张表） |
| 附件 | `attachment` | `[{ "name": "文件名", "url": "/api/uploads/<uploadId>" }]`；先 `POST /api/uploads`（body `{ "filename", "contentBase64", "mime" }`），用返回的 `id` 拼 URL |
| 公式 / 引用 | `formula` / `lookup` | 只读，不要写入 |
| 按钮 | `button` | 只读；触发用 `POST /api/records/{recordId}/buttons/{fieldId}` |
| 系统字段 | `auto_number` / `created_time` / `updated_time` / `created_by` | 只读，不要写入 |
| 其他 | `barcode` / `geolocation` / `signature` / `duplex_link` 等 | 新建字段时可用；写入格式先 `GET /api/tables/{tableId}` 看字段配置 |
