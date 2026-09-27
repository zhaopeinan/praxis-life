import type { Store } from "./store.js";
import type { BaseSummary, FieldDraft } from "./types.js";

export const TEMPLATES = [
  {
    id: "requirements",
    name: "需求管理",
    description: "需求池、优先级、状态看板，以及迭代表。",
  },
  {
    id: "engineering",
    name: "研发进度",
    description: "开发任务看板和缺陷跟踪，适合看版本进度。",
  },
  {
    id: "todos",
    name: "个人待办",
    description: "工作 / 生活统一待办，含看板、日历，以及飞书提醒与日历订阅入口。",
  },
  {
    id: "research",
    name: "科研管理",
    description: "论文主线 + 挂靠任务 + 投稿记录；看板 / 日历，以及飞书提醒与日历订阅。",
  },
] as const;

export type TemplateId = (typeof TEMPLATES)[number]["id"];

export async function createTemplate(store: Store, template: TemplateId): Promise<BaseSummary> {
  if (template === "requirements") return createRequirements(store);
  if (template === "todos") return createTodos(store);
  if (template === "research") return createResearch(store);
  return createEngineering(store);
}

async function createRequirements(store: Store): Promise<BaseSummary> {
  const base = await store.createBase("需求管理");
  const requirements = await store.createTable(base.id, {
    name: "需求",
    defaultViewName: "表格",
    fields: [
      { name: "标题", type: "text" },
      { name: "描述", type: "long_text" },
      select("状态", ["待办", "进行中", "评审中", "已完成"]),
      select("优先级", ["P0", "P1", "P2", "P3"]),
      { name: "负责人", type: "text" },
      { name: "截止日期", type: "date" },
      select("来源", ["内部规划", "用户反馈", "缺陷"]),
    ],
  });
  await store.createView(requirements.id, { name: "看板", type: "kanban", groupField: "状态" });
  await store.createRecord(requirements.id, {
    标题: "示例：补齐导出",
    描述: "把当前视图导出为 CSV，方便和现有表格对照。",
    状态: "待办",
    优先级: "P1",
    负责人: "研发",
    来源: "内部规划",
  });

  const iterations = await store.createTable(base.id, {
    name: "迭代",
    defaultViewName: "表格",
    fields: [
      { name: "名称", type: "text" },
      { name: "周期", type: "text" },
      { name: "目标", type: "long_text" },
      select("状态", ["规划中", "进行中", "已结束"]),
    ],
  });
  await store.createView(iterations.id, { name: "看板", type: "kanban", groupField: "状态" });
  await store.createRecord(iterations.id, {
    名称: "当前迭代",
    周期: "本周",
    目标: "收口本周承诺的需求。",
    状态: "进行中",
  });
  return (await store.listBases()).find((item) => item.id === base.id) ?? base;
}

async function createEngineering(store: Store): Promise<BaseSummary> {
  const base = await store.createBase("研发进度");
  const tasks = await store.createTable(base.id, {
    name: "任务",
    defaultViewName: "表格",
    fields: [
      { name: "标题", type: "text" },
      { name: "说明", type: "long_text" },
      select("状态", ["待开发", "开发中", "代码评审", "测试中", "已上线"]),
      select("优先级", ["P0", "P1", "P2"]),
      { name: "负责人", type: "text" },
      { name: "预计完成", type: "date" },
      { name: "阻塞", type: "checkbox" },
    ],
  });
  await store.createView(tasks.id, { name: "看板", type: "kanban", groupField: "状态" });
  await store.createRecord(tasks.id, {
    标题: "示例：接入登录",
    说明: "注册、验证码和权限走通后再开放给团队。",
    状态: "开发中",
    优先级: "P0",
    负责人: "研发",
    阻塞: false,
  });

  const bugs = await store.createTable(base.id, {
    name: "缺陷",
    defaultViewName: "表格",
    fields: [
      { name: "标题", type: "text" },
      select("严重程度", ["致命", "严重", "一般", "轻微"]),
      select("状态", ["待修复", "修复中", "已验证"]),
      { name: "负责人", type: "text" },
    ],
  });
  await store.createView(bugs.id, { name: "看板", type: "kanban", groupField: "状态" });
  await store.createRecord(bugs.id, {
    标题: "示例：看板拖拽后状态未刷新",
    严重程度: "一般",
    状态: "待修复",
    负责人: "研发",
  });
  return (await store.listBases()).find((item) => item.id === base.id) ?? base;
}

async function createTodos(store: Store): Promise<BaseSummary> {
  const base = await store.createBase("待办中心");
  const inbox = await store.createTable(base.id, {
    name: "待办",
    defaultViewName: "全部",
    fields: [
      { name: "标题", type: "text" },
      { name: "说明", type: "long_text" },
      select("领域", ["工作", "生活", "科研"]),
      select("状态", ["待办", "进行中", "已完成", "已搁置"]),
      select("优先级", ["P0", "P1", "P2", "P3"]),
      { name: "截止日期", type: "date" },
    ],
  });
  const fields = inbox.fields;
  const domain = fields.find((field) => field.name === "领域");
  const status = fields.find((field) => field.name === "状态");
  await store.createView(inbox.id, { name: "看板", type: "kanban", groupField: "状态" });
  await store.createView(inbox.id, { name: "日历", type: "calendar", dateField: "截止日期" });
  if (domain) {
    for (const name of ["工作", "生活", "科研"] as const) {
      const view = await store.createView(inbox.id, { name, type: "grid" });
      await store.updateView(view.id, { config: { filters: [{ fieldId: domain.id, op: "eq", value: name }] } });
    }
  }
  if (status) {
    const open = await store.createView(inbox.id, { name: "未完成", type: "grid" });
    await store.updateView(open.id, {
      config: { filters: [{ fieldId: status.id, op: "neq", value: "已完成" }, { fieldId: status.id, op: "neq", value: "已搁置" }] },
    });
  }
  await store.createRecord(inbox.id, {
    标题: "示例：整理本周工作",
    说明: "把会议结论拆成可执行事项。",
    领域: "工作",
    状态: "进行中",
    优先级: "P1",
  });
  await store.createRecord(inbox.id, {
    标题: "示例：预约体检",
    说明: "生活事项也放这里，方便日历订阅。",
    领域: "生活",
    状态: "待办",
    优先级: "P2",
  });
  await store.createRecord(inbox.id, {
    标题: "示例：投稿截止日期",
    说明: "科研 DDL 用日历视图盯。",
    领域: "科研",
    状态: "待办",
    优先级: "P0",
    截止日期: new Date().toISOString().slice(0, 10),
  });
  await store.createAutomation(inbox.id, {
    name: "新建待办通知飞书",
    enabled: true,
    trigger: { type: "record_created" },
    actions: [{ type: "feishu_bot", text: "【新待办】{标题}\n领域：{领域} · 优先级：{优先级}\n截止：{截止日期}\n{说明}" }],
  });
  await store.createAutomation(inbox.id, {
    name: "每日待办摘要到飞书",
    enabled: true,
    trigger: { type: "schedule", cron: "daily:09:00" },
    actions: [{ type: "feishu_digest", daysAhead: 2, excludeStatuses: ["已完成", "已搁置"] }],
  });
  return (await store.listBases()).find((item) => item.id === base.id) ?? base;
}

async function createResearch(store: Store): Promise<BaseSummary> {
  const base = await store.createBase("科研管理");
  const papers = await store.createTable(base.id, {
    name: "论文",
    defaultViewName: "表格",
    fields: [
      { name: "标题", type: "text" },
      { name: "摘要要点", type: "long_text" },
      select("状态", ["选题", "写作中", "投稿中", "返修中", "已录用", "已拒稿", "已搁置"]),
      select("优先级", ["P0", "P1", "P2", "P3"]),
      { name: "目标会议/期刊", type: "text" },
      { name: "截稿日期", type: "date" },
      { name: "负责人", type: "text" },
      { name: "备注", type: "long_text" },
    ],
  });
  const paperStatus = papers.fields.find((field) => field.name === "状态");
  await store.createView(papers.id, { name: "看板", type: "kanban", groupField: "状态" });
  await store.createView(papers.id, { name: "日历", type: "calendar", dateField: "截稿日期" });
  if (paperStatus) {
    const active = await store.createView(papers.id, { name: "进行中", type: "grid" });
    await store.updateView(active.id, {
      config: {
        filters: [
          { fieldId: paperStatus.id, op: "neq", value: "已录用" },
          { fieldId: paperStatus.id, op: "neq", value: "已拒稿" },
          { fieldId: paperStatus.id, op: "neq", value: "已搁置" },
        ],
      },
    });
  }

  const deadline = addDaysYmd(14);
  const paper1 = await store.createRecord(
    papers.id,
    {
      标题: "示例：多模态检索",
      摘要要点: "统一图文表征，提升开放域检索召回。",
      状态: "写作中",
      优先级: "P0",
      "目标会议/期刊": "CVPR",
      截稿日期: deadline,
      负责人: "我",
    },
    { skipAutomation: true },
  );
  const paper2 = await store.createRecord(
    papers.id,
    {
      标题: "示例：小样本分割",
      摘要要点: "少样本条件下的稠密预测。",
      状态: "投稿中",
      优先级: "P1",
      "目标会议/期刊": "ICCV",
      负责人: "我",
    },
    { skipAutomation: true },
  );

  const tasks = await store.createTable(base.id, {
    name: "任务",
    defaultViewName: "表格",
    fields: [
      { name: "标题", type: "text" },
      { name: "所属论文", type: "link", linkTableId: papers.id },
      select("类型", ["读文献", "实验", "写作", "改图", "投稿事务", "其他"]),
      select("状态", ["待办", "进行中", "已完成", "已搁置"]),
      { name: "截止日期", type: "date" },
      { name: "说明", type: "long_text" },
    ],
  });
  const taskStatus = tasks.fields.find((field) => field.name === "状态");
  await store.createView(tasks.id, { name: "看板", type: "kanban", groupField: "状态" });
  await store.createView(tasks.id, { name: "日历", type: "calendar", dateField: "截止日期" });
  if (taskStatus) {
    const open = await store.createView(tasks.id, { name: "未完成", type: "grid" });
    await store.updateView(open.id, {
      config: {
        filters: [
          { fieldId: taskStatus.id, op: "neq", value: "已完成" },
          { fieldId: taskStatus.id, op: "neq", value: "已搁置" },
        ],
      },
    });
  }

  const paperRef = [paper1.record.id];
  await store.createRecord(
    tasks.id,
    {
      标题: "精读相关 survey",
      所属论文: paperRef,
      类型: "读文献",
      状态: "待办",
      截止日期: addDaysYmd(3),
      说明: "整理相关工作表，标出可对比 baseline。",
    },
    { skipAutomation: true },
  );
  await store.createRecord(
    tasks.id,
    {
      标题: "补消融实验",
      所属论文: paperRef,
      类型: "实验",
      状态: "进行中",
      截止日期: addDaysYmd(7),
    },
    { skipAutomation: true },
  );
  await store.createRecord(
    tasks.id,
    {
      标题: "整理 contribution 三段",
      所属论文: paperRef,
      类型: "写作",
      状态: "待办",
      截止日期: addDaysYmd(5),
    },
    { skipAutomation: true },
  );

  const submissions = await store.createTable(base.id, {
    name: "投稿记录",
    defaultViewName: "表格",
    fields: [
      { name: "所属论文", type: "link", linkTableId: papers.id },
      { name: "会议/期刊", type: "text" },
      { name: "投稿日期", type: "date" },
      select("结果", ["审稿中", "接收", "小修", "大修", "拒稿", "撤稿"]),
      { name: "通知日期", type: "date" },
      { name: "意见摘要", type: "long_text" },
    ],
  });
  const resultField = submissions.fields.find((field) => field.name === "结果");
  if (resultField) {
    const reviewing = await store.createView(submissions.id, { name: "审稿中", type: "grid" });
    await store.updateView(reviewing.id, {
      config: { filters: [{ fieldId: resultField.id, op: "eq", value: "审稿中" }] },
    });
  }
  await store.createRecord(
    submissions.id,
    {
      所属论文: [paper2.record.id],
      "会议/期刊": "ICCV",
      投稿日期: addDaysYmd(-20),
      结果: "审稿中",
      意见摘要: "等待一审。",
    },
    { skipAutomation: true },
  );
  await store.createRecord(
    submissions.id,
    {
      所属论文: [paper2.record.id],
      "会议/期刊": "某 Workshop",
      投稿日期: addDaysYmd(-90),
      结果: "拒稿",
      通知日期: addDaysYmd(-60),
      意见摘要: "示例：改投前的一次尝试。",
    },
    { skipAutomation: true },
  );

  await store.createAutomation(papers.id, {
    name: "新建论文通知飞书",
    enabled: true,
    trigger: { type: "record_created" },
    actions: [
      {
        type: "feishu_bot",
        text: "【新论文】{标题}\n状态：{状态} · 优先级：{优先级}\n目标：{目标会议/期刊}\n截稿：{截稿日期}",
      },
    ],
  });
  await store.createAutomation(papers.id, {
    name: "每日论文截稿摘要到飞书",
    enabled: true,
    trigger: { type: "schedule", cron: "daily:09:00" },
    actions: [
      {
        type: "feishu_digest",
        daysAhead: 7,
        dateField: "截稿日期",
        excludeStatuses: ["已录用", "已拒稿", "已搁置"],
        text: "【论文截稿摘要】近 7 天",
      },
    ],
  });
  await store.createAutomation(tasks.id, {
    name: "新建科研任务通知飞书",
    enabled: true,
    trigger: { type: "record_created" },
    actions: [{ type: "feishu_bot", text: "【科研任务】{标题}\n类型：{类型} · 状态：{状态}\n截止：{截止日期}\n{说明}" }],
  });
  await store.createAutomation(tasks.id, {
    name: "每日科研任务摘要到飞书",
    enabled: true,
    trigger: { type: "schedule", cron: "daily:09:00" },
    actions: [
      {
        type: "feishu_digest",
        daysAhead: 7,
        dateField: "截止日期",
        excludeStatuses: ["已完成", "已搁置"],
        text: "【科研任务摘要】近 7 天",
      },
    ],
  });

  return (await store.listBases()).find((item) => item.id === base.id) ?? base;
}

function addDaysYmd(delta: number): string {
  const d = new Date();
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function select(name: string, options: string[]): FieldDraft {
  return { name, type: "single_select", options };
}
