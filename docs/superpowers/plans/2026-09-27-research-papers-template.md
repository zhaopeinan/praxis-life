# 科研管理模板 Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** 新增一键模板 `research`（科研管理）：论文 + 任务 + 投稿记录，含视图、示例与飞书自动化。

**Architecture:** 在 `src/templates.ts` 增加 `createResearch`，与现有 `todos`/`requirements` 同模式；同步 MCP 枚举与 store 测试。

**Tech Stack:** TypeScript、现有 Store `createTable` / `createView` / `createRecord` / `createAutomation`、`link` 字段。

## Global Constraints

- 遵循 `docs/superpowers/specs/2026-09-27-research-papers-template-design.md`
- 不新增独立文献库；关联用单向 `link`
- 日期示例相对今天计算

## Task 1: 模板实现 + 入口

- [x] `src/templates.ts`：TEMPLATES + `createResearch`
- [x] `src/mcp.ts`：enum / 文案
- [x] `src/mcp-catalog.ts`：描述
- [x] `src/store.test.ts`：模板断言
- [x] `docs/MCP_AGENT_GUIDE.md`：一句入口（可选）
- [x] `npm test` 通过
