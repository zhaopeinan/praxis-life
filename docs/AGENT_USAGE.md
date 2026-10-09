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
2. `GET http://47.122.123.1/api/bases` — 列出可见「空间」及其「清单」（tables）
3. 选定 `baseId` 后：`GET http://47.122.123.1/api/bases/{baseId}` 了解空间下的清单
4. 选定 `tableId` 后：`GET http://47.122.123.1/api/tables/{tableId}` 了解字段与记录
5. 需要筛选：`POST http://47.122.123.1/api/tables/{tableId}/query`，body 示例：

```json
{
  "filters": [{ "field": "状态", "op": "eq", "value": "进行中" }],
  "conjunction": "and",
  "limit": 50
}
```

**若 `/api/bases` 为空**：请用户在「Agent 管理」中点开你的 Agent「编辑」，勾选可访问的空间。

## 产品语义 ↔ API

| 界面用语 | API | 说明 |
|----------|-----|------|
| 空间 | base（`baseId`） | 顶层容器，包含多个清单 |
| 清单 / 数据表 | table（`tableId`） | 空间内的数据表 |
| 记录 | record（`recordId`） | 表内的一行数据 |
| 字段 | field | 读写记录时用**字段名**作 JSON 键，不要用内部 field id |
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
- **公式 / 按钮 / 系统字段**（如 `created_time`）：不要直接 update
- 筛选运算符：`eq` `neq` `contains` `not_contains` `gt` `gte` `lt` `lte` `is_empty` `is_not_empty`

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

### 新建字段

```bash
POST http://47.122.123.1/api/tables/{tableId}/fields
```

### 评论

```bash
POST http://47.122.123.1/api/records/{recordId}/comments
```

### 导出 CSV

```bash
GET http://47.122.123.1/api/tables/{tableId}/export.csv
```

（同样需要带 `Authorization: Bearer <令牌>`）

### 飞书集成

在空间设置里配置 webhook 后，可用相关 integrations 接口测试连接或发送摘要。

## 推荐工作流示例

### 查并进行中的待办并勾掉一条

1. `GET /api/bases` → 找到「个人待办」空间下的待办表 `tableId`
2. `POST /api/tables/{tableId}/query`，筛选 `状态 eq 进行中`（或表内实际选项名）
3. `PATCH /api/records/{recordId}`，`{ "fields": { "状态": "已完成" } }`

### 从模板开一套科研管理

1. `POST /api/templates/research`
2. `GET /api/bases` 确认新空间
3. 按字段名往「论文」「任务」「投稿记录」写记录

### 在文档中查找并打开关联记录

1. `GET /api/bases` 找到目标空间
2. `GET /api/documents?baseId={baseId}` 列出文档
3. 读取文档内容，找到 `record:` 或 `table:` 标记
4. `GET /api/tables/{tableId}` 获取记录详情
5. 如需编辑：`PATCH /api/records/{recordId}`

## 权限提醒

- Agent 只能看到管理员授权给它的空间
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
| `403 Forbidden` | 令牌无效或空间未授权 | 检查令牌前缀（dwa_ / dw_），确认 Agent 已授权该空间 |
| `404 Not Found` | baseId / tableId / recordId 不存在 | 重新 `GET /api/bases` 获取正确 ID |
| `Agent 不能创建多维表格` | 使用了 Agent 令牌创建空间 | 改用个人令牌（dw_）或在网页端手动创建 |
| `Connection reset by peer` | 用了域名而非 IP | 改用 `http://47.122.123.1` 裸 IP 访问 |

## 视图类型说明

| 视图类型 | type | 配置要点 |
|----------|------|----------|
| 表格 | `grid` | 支持分组、筛选、排序、填色规则 |
| 看板 | `kanban` | 需要一个单选字段作为 `groupFieldId` |
| 日历 | `calendar` | 需要一个日期字段作为 `dateFieldId` |
| 甘特图 | `gantt` | 需要开始/结束日期字段，可选进度字段 |
| 画册 | `gallery` | 需要标题字段和封面字段 |
| 表单 | `form` | 只展示可填写字段，用于快速录入 |

## 字段类型说明

| 字段类型 | type | 写入格式 |
|----------|------|----------|
| 文本 | `text` | 字符串 |
| 数字 | `number` | 数字 |
| 日期 | `date` | `"YYYY-MM-DD"` |
| 单选 | `single_select` | 选项名称字符串 |
| 多选 | `multi_select` | 选项名称数组 |
| 复选框 | `checkbox` | `true` / `false` |
| 人员 | `user` | 用户 ID（从 `GET /api/bases/{baseId}/members` 获取） |
| 关联 | `link` | 关联记录 ID 数组 |
| 附件 | `attachment` | 先上传到 `/api/upload`，用返回的 `fileId` |
| 公式 | `formula` | 只读，不要写入 |
| 按钮 | `button` | 用 `POST /api/records/{recordId}/fields/{fieldId}/click` 触发 |
