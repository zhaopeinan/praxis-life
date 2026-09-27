# 多维

自托管的多维表格。用表格 / 看板 / 日历管理任务与项目，并通过 REST 或 MCP 让 Agent 读写同一份数据。

## 启动

```bash
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:5174 。数据在 `data/duowei.db`。

**不开放自助注册。** 库为空时，首次访问可创建首位管理员（或设置环境变量自动引导），之后由管理员在「用户管理」开通账号。登录需填写**图形验证码**；也可改用邮箱验证码登录（仍须图形验证码）。

空库自动引导（可选）：

```bash
DUOWEI_BOOTSTRAP_EMAIL=admin@example.com
DUOWEI_BOOTSTRAP_PASSWORD=至少8位密码
DUOWEI_BOOTSTRAP_NAME=管理员
```

未配置 SMTP 时，邮箱验证码会显示在登录表单里（开发模式）。生产环境设置 `DUOWEI_DEV_CODES=0`，并配置邮件：

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="多维 <noreply@example.com>"
```

服务默认只监听 `127.0.0.1:8787`。对外暴露时设置 `DUOWEI_HOST`、`DUOWEI_COOKIE_SECURE=1`。

## 权限

- 系统角色：管理员、成员。管理员可创建/启停用户、重置密码，并访问全部多维表格。
- 表格角色：所有者、可编辑、可查看。所有者可以分享和删除整表。
- 登录失败会累计锁定 10 分钟；图形验证码一次性有效；邮箱验证码 10 分钟有效，每小时最多发送 5 次。

## Agent / MCP

外部 AI Agent **须先注册**：管理员在「Agent 管理」创建并启用，或 Agent 调用 `POST /api/mcp-agents/register` 后由管理员批准。批准后获得一次性 `dwa_…` 令牌。

MCP 配置（**仅接受 Agent 令牌**，个人访问令牌 `dw_…` 不能用于 MCP）：

```json
{
  "mcpServers": {
    "duowei": {
      "command": "npx",
      "args": ["tsx", "src/mcp.ts"],
      "cwd": "/绝对路径/DuoWei",
      "env": { "DUOWEI_TOKEN": "dwa_..." }
    }
  }
}
```

发给 AI Agent 学习用的对接手册见：[docs/MCP_AGENT_GUIDE.md](./docs/MCP_AGENT_GUIDE.md)。

个人「访问令牌」仍可用于 REST。常用入口：

- `GET /api/bases`
- `GET /api/tables/:tableId`
- `POST /api/tables/:tableId/query`
- `POST /api/tables/:tableId/records`
- `PATCH /api/records/:recordId`
- `POST /api/templates/requirements` 或 `engineering`

记录字段用字段名，不使用内部 id。单选传选项名称，日期用 `YYYY-MM-DD`。看板换列就是更新分组字段。

个人待办：模板 `todos`。科研管理：模板 `research`（论文 + 任务 + 投稿记录）。在「日历 / 飞书」配置飞书自定义机器人，并把 ICS 订阅到系统日历或飞书日历。

## 测试

```bash
npm test
```
