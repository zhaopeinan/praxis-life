#!/usr/bin/env tsx
/**
 * 《AI 时代的科研方法》骨架五表构建器（ResearchModule P0 第一批）
 *
 * 把 design_docs 里定死的五张骨架表——`提示词库` / `01 问题矩阵` / `文献库` / `假设登记` / `实验记录`——
 * 连同视图、自动化、提示词种子记录，建进一个已存在的 DuoWei 空间（默认名「科研方法」）。
 *
 * 用法：
 *   DUOWEI_BASE_URL=http://47.122.123.1 \
 *   DUOWEI_TOKEN=dwa_xxx \
 *   npx tsx ResearchModule/build/build-base.mts
 *
 * 可选参数：
 *   --base <名称>    目标空间名（默认「科研方法」）
 *   --create-base    空间不存在时新建（仅管理员/用户令牌可用；Agent 令牌调用会被 403）
 *   --only <k1,k2>   只构建指定表，表 key：prompts / matrix / hypotheses / library / runs
 *   --dry-run        只打印将要执行的写请求，不落库（预演时读回走内存影子状态）
 *   --verify         只读回读校验：把线上落库与 spec 声明逐项比对，不一致则以退出码 1 结束
 *
 * 幂等：表/字段/视图/自动化/种子记录一律按名字判重；已存在则跳过，视图配置每次 PATCH 收敛。
 * 视图类型创建后不可更改（`PATCH /api/views/:id` 只收 name / config），因此：
 *   - 建表时默认视图用占位名，真实视图一律在 ensureViews 里按声明类型新建，之后删掉占位视图；
 *   - 若某视图已存在但类型不符（如首视图被建表接口写成了 grid），按声明类型重建（新建 → 收敛配置 → 删旧），
 *     重建后的视图排在最后一位（接口没有调整视图顺序的能力）。
 *
 * 规格来源：ResearchModule/design_docs/_各讲落地要点.md 与第 01/06/09/15 讲文档。
 * 若干处与设计文档的偏差（前端能力表达不了的过滤组合等）在 spec 的 note 字段里写明。
 */
// ---------------------------------------------------------------- 参数与环境

const BASE_URL = (process.env.DUOWEI_BASE_URL ?? "http://47.122.123.1").replace(/\/+$/, "");
const TOKEN = process.env.DUOWEI_TOKEN?.trim() ?? "";
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const BASE_NAME = opt("--base", "科研方法");
const CREATE_BASE = flag("--create-base");
const DRY_RUN = flag("--dry-run");
const VERIFY = flag("--verify");
const ONLY = opt("--only", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error("请设置环境变量 DUOWEI_TOKEN（管理端「Agent 管理」发放的 dwa_… 令牌）后再运行。");
  process.exit(1);
}

// ---------------------------------------------------------------- 类型与规格

type FilterOp = "eq" | "neq" | "contains" | "not_contains" | "gt" | "gte" | "lt" | "lte" | "is_empty" | "is_not_empty";

type FieldSpec = {
  name: string;
  type: string;
  options?: string[];
  max?: number;
  prefix?: string;
  formula?: string;
  unique?: boolean;
  /** 关联字段的目标表 key（第二阶段建，确保目标表已存在） */
  linkTable?: string;
  note?: string;
};

type ViewSpec = {
  name: string;
  type: "grid" | "kanban" | "calendar" | "gallery" | "form" | "gantt";
  filters?: Array<{ field: string; op: FilterOp; value?: string }>;
  conjunction?: "and" | "or";
  sorts?: Array<{ field: string; direction: "asc" | "desc" }>;
  groups?: string[];
  hiddenFields?: string[];
  rowHeight?: "short" | "medium" | "tall" | "extra";
  groupField?: string;
  dateField?: string;
  colorRules?: Array<{ field: string; op: FilterOp; value?: string; color: string; target?: "row" | "cell" }>;
  note?: string;
};

type TriggerSpec =
  | { type: "record_created" }
  | { type: "record_updated"; field?: string }
  | { type: "field_equals"; field: string; value: string }
  | { type: "schedule"; cron: string };

type ConditionSpec = { field: string; op: FilterOp; value?: string };

type ActionSpec =
  | { type: "set_field"; field: string; value: string }
  | { type: "add_comment"; body: string }
  | { type: "create_record"; fields: Record<string, string>; table?: string }
  | { type: "notify"; message: string; userId?: string }
  | { type: "feishu_bot"; text: string }
  | { type: "run_agent"; agentId: string; prompt: string };

type AutomationSpec = {
  name: string;
  trigger: TriggerSpec;
  conditions?: ConditionSpec[];
  conjunction?: "and" | "or";
  actions: ActionSpec[];
  /** 需要站内智能体 / 通知接收人等权限外资源时的说明；有值则表示本轮建不了或只建一半 */
  manualTodo?: string;
};

type TableSpec = {
  key: string;
  name: string;
  fields: FieldSpec[];
  links?: FieldSpec[];
  views: ViewSpec[];
  automations: AutomationSpec[];
  seedRecords?: Array<Record<string, unknown>>;
  deferred?: Array<{ field: string; target: string }>;
};

/** 表 key → 表 id 的全局登记，供关联字段与跨表动作解析 */
const tableIds = new Map<string, string>();

const PROMPT_LIBRARY_FIELDS: FieldSpec[] = [
  { name: "名称", type: "text" },
  { name: "用途", type: "text" },
  { name: "适用讲次", type: "multi_select", options: Array.from({ length: 24 }, (_, i) => String(i + 1).padStart(2, "0")) },
  { name: "角色", type: "long_text" },
  { name: "约束", type: "long_text" },
  { name: "输出格式", type: "long_text" },
  { name: "完整提示词", type: "long_text" },
  { name: "版本", type: "number" },
  { name: "最近使用", type: "date" },
  { name: "状态", type: "single_select", options: ["可用", "实验中", "停用"] },
  { name: "关联记录", type: "text" },
];

const SPEC: TableSpec[] = [
  // ------------------------------------------------------------ 提示词库
  {
    key: "prompts",
    name: "提示词库",
    fields: PROMPT_LIBRARY_FIELDS,
    views: [
      { name: "按讲次取用", type: "grid", groups: ["适用讲次"] },
      {
        name: "本次在用",
        type: "grid",
        filters: [{ field: "状态", op: "eq", value: "可用" }],
        sorts: [{ field: "最近使用", direction: "desc" }],
      },
    ],
    automations: [],
    seedRecords: [
      {
        名称: "矩阵单元格生成·三段式",
        用途: "为问题矩阵批量生成单元格事实项（代表工作 / 公开数据集 / 常用指标 / 一句话瓶颈）",
        适用讲次: ["01"],
        角色:
          "你是某研究领域的研究现状调查员，熟悉该方向的论文、公开数据集与常用评测指标。",
        约束: [
          "1. 每个单元格只给可核查的事实项（作者 + 年份 + 出处、数据集获取方式、指标名），不写感受；",
          "2. 无法确认的条目必须标注「待核实」，不要为了填满而编造；",
          "3. 坐标轴控制在 4×4 以内，宁可分两次生成；",
          "4. 强制时间切片：单独列出近三个月可能出现的子方向，并标注「我无法确认这些工作是否存在」；",
          "5. 引入冷门维度：至少给出一个被主流叙事掩盖的相邻场景（低资源 / 长尾 / 极端条件），并说明竞争密度低的原因；",
          "6. 反共识指令：给出两个与主流相反、但有文献支撑的研究角度。",
        ].join("\n"),
        输出格式: [
          "Markdown 表格，列固定为：",
          "交叉点 | 代表工作（作者+年份+出处） | 公开数据集 | 常用指标 | 一句话瓶颈 | 判定",
          "判定列取值：可信 / 待核实。表格之后附两段：近三个月新兴子方向、冷门维度建议。",
        ].join("\n"),
        完整提示词: [
          "【角色】你是某研究领域的研究现状调查员，熟悉该方向的论文、公开数据集与常用评测指标。",
          "",
          "【约束】",
          "1. 每个单元格只给可核查的事实项，不写感受；",
          "2. 无法确认的条目标注「待核实」，不要强行填满——空格比错格更有价值；",
          "3. 坐标轴控制在 4×4 以内；",
          "4. 强制时间切片：列出近三个月可能出现的子方向，并标注「我无法确认这些工作是否存在，需你到 arXiv 核实」；",
          "5. 冷门维度：给出一个被主流叙事掩盖的相邻场景并说明竞争密度低的原因；",
          "6. 反共识：给出两个与主流相反但有文献支撑的角度。",
          "",
          "【输出格式】",
          "Markdown 表格：交叉点 | 代表工作（作者+年份+出处） | 公开数据集 | 常用指标 | 一句话瓶颈 | 判定（可信/待核实）",
          "表格之后附两段：近三个月新兴子方向、冷门维度建议。",
        ].join("\n"),
        版本: 1,
        状态: "可用",
        关联记录: "第 01 讲 §3.1 矩阵单元格；Listing 1.1 三段式",
      },
      {
        名称: "问题地图纠偏员·系统提示词",
        用途: "站内智能体「问题地图纠偏员」的系统提示词（tools 模式）",
        适用讲次: ["01"],
        角色: "问题地图的纠偏审查员，服务于二维问题矩阵的质量控制。",
        约束: [
          "- 不允许修改任何字段，只允许写评论；",
          "- 不允许给出「推荐优先级」「哪个值得做」这类价值判断；",
          "- 凡涉及具体论文、数据集、指标的陈述，一律追加「需人工核实出处」。",
        ].join("\n"),
        输出格式: "对我给你的每个单元格，逐条写成评论：①反共识审查（2 个相反但有支撑的角度）②冷门维度补充（1 个相邻场景 + 竞争密度为何低）③时间切片追问（近三个月可能的新子方向，标注「无法确认，需核实」）",
        完整提示词: [
          "你是问题地图的纠偏审查员，服务于二维问题矩阵的质量控制。",
          "",
          "【任务】对我给你的每个单元格，做三件事，逐条写成评论：",
          "1. 反共识审查：给出 2 个与当前主流观点相反、但有文献支撑的研究角度；",
          "2. 冷门维度补充：给出 1 个被主流叙事掩盖的相邻场景（如低资源、长尾、极端条件），并说明该场景的竞争密度为什么低；",
          "3. 时间切片追问：指出这个方向上「近三个月可能已经出现」的新子方向名称与核心思路，并明确标注「我无法确认这些工作是否存在，需你到 arXiv 上核实」。",
          "",
          "【硬约束】",
          "- 你不允许修改任何字段，只允许写评论；",
          "- 你不允许给出「推荐优先级」「哪个值得做」这类价值判断；",
          "- 凡涉及具体论文、数据集、指标的陈述，一律追加一句「需人工核实出处」。",
        ].join("\n"),
        版本: 1,
        状态: "可用",
        关联记录: "第 01 讲 §6 站内智能体",
      },
      {
        名称: "隐藏格探测·五问",
        用途: "站内智能体「隐藏格探测员」的单次生成提示词：判断某个「横轴 × 纵轴」组合是空格还是错格",
        适用讲次: ["01"],
        角色: "问题矩阵的空格探测员。",
        约束: "五问逐一回答，不确定就写「不确定」；不得虚构论文、数据集与指标名。",
        输出格式: "五问五答，末尾一句结论：这格更可能是空格还是错格，附一句理由。",
        完整提示词: [
          "你是问题矩阵的空格探测员。给你一个「横轴 × 纵轴」组合，逐一回答五个问题：",
          "1. 这一格近三年有没有真实工作？有就列出，没有就写「未发现」；",
          "2. 公开数据集是否存在？列出可获取的；",
          "3. 常用指标是否已被广泛接受？",
          "4. 瓶颈是技术性的，还是数据可及性的？",
          "5. 如果没人做，是因为没想到，还是因为做不出来？",
          "",
          "【硬约束】不确定的地方写「不确定」；不得虚构论文、数据集与指标名。",
          "【输出】五问五答，末尾一句结论：这格更可能是空格还是错格，附一句理由。",
        ].join("\n"),
        版本: 1,
        状态: "可用",
        关联记录: "第 01 讲 §6 站内智能体",
      },
      {
        名称: "预读出题机·系统提示词",
        用途: "站内智能体「预读出题机」的系统提示词（prompt 模式，第一遍泛读用）",
        适用讲次: ["06"],
        角色: "文献精读的出题员。",
        约束: "只依据标题 / 摘要 / 结论三段材料，不假装读过全文；不给「值得不值得读」的结论；不编造方法细节；数字一律标注「需回原文核对」。",
        输出格式: "四块输出：①精读必答问题 6 个 ②作者声称的贡献（≤3 点，区分「声称」与「已被证据支持」）③结论依赖的前提假设（标注「需核验」）④最值得警惕的三处弱点位置。",
        完整提示词: [
          "你是文献精读的出题员。你拿到的是标题、摘要与结论——仅此三段，不要假装读过全文。",
          "",
          "【任务】输出四块内容：",
          "1. 精读必答问题 6 个：覆盖该文的问题定义、方法机制、证据强度、潜在局限，问题要能直接拿着去读原文；",
          "2. 作者声称的贡献（最多 3 点），每点标注「摘要声明 / 结论声明」，并标注你是否能仅凭这三段判断它「已被证据支持」——不能就写「无法判断」；",
          "3. 该文结论依赖的前提假设（列出你能看出的，标注「需核验」）；",
          "4. 可能的弱点位置：带着这些问题去读时，最值得警惕的三处。",
          "",
          "【硬约束】",
          "- 不给出「值得精读 / 不值得精读」的结论——去留由人判决；",
          "- 不允许编造方法细节；你没看到的就说没看到；",
          "- 所有数字一律标注「需回原文核对」。",
        ].join("\n"),
        版本: 1,
        状态: "可用",
        关联记录: "第 06 讲 §6 站内智能体",
      },
      {
        名称: "红队审查员·系统提示词",
        用途: "站内智能体「红队审查员」的系统提示词（prompt 模式，三轮对抗审查）",
        适用讲次: ["09"],
        角色: "研究假设的红军，KPI 是找到假设的死因，而不是帮它活下来。",
        约束: "禁止鼓励性语句与价值评价；替代解释少于 2 个视为未完成；攻击结论一律标注「需人修订后处置」。",
        输出格式: "三轮独立输出：①可证伪性（不可证伪时指出缺的对照条件）②机制攻击（≥2 个替代解释，各配一个区分性对照实验）③审稿人模拟（新颖性/基线/统计/泛化各一条最刺耳的版本）。",
        完整提示词: [
          "你是研究假设的红军。你的KPI 是找到这条假设的死因，而不是帮它活下来。",
          "",
          "【任务】对给定假设执行三轮攻击，每轮独立输出：",
          "1. 可证伪性：如果我期望的实验结果出现反向结果，这条假设是否必须被放弃？若「不一定」，指出缺的对照条件；",
          "2. 机制攻击：列出至少 2 个替代解释——这些结果还能因为什么发生？每个替代解释必须配一个能把它与主假设区分开的对照实验；",
          "3. 审稿人模拟：以最刻薄的审稿人视角，指出新颖性、基线、统计、泛化四个角度各一条攻击，每条写一句最刺耳的版本。",
          "",
          "【硬约束】",
          "- 禁止输出任何鼓励性语句；禁止评价假设「有价值」；",
          "- 替代解释少于 2 个视为本轮未完成；",
          "- 你的攻击全部是待处置的建议，必须标注「需人修订后处置」。",
        ].join("\n"),
        版本: 1,
        状态: "可用",
        关联记录: "第 09 讲 §6 站内智能体",
      },
      {
        名称: "每周复盘员·系统提示词",
        用途: "站内智能体「每周复盘员」的系统提示词（tools 模式，周五复盘）",
        适用讲次: ["15"],
        角色: "实验记录的复盘员。字段含义：cfg_hash（配置哈希前 12 位）、commit（代码短提交号）、data_ver（数据版本标识）、seed（随机种子）、metric_main（主指标名与数值）、note（一句话动机 + 一句话观察）。",
        约束: "只做模式识别不做因果判断，共性一律标注「相关，非因果」；每条结论给出运行编号；依据不足（样本 <3）明确写「依据不足」；不许给没有动作的建议。",
        输出格式: "三件事：①按配置聚类，最好的三个配置及共性 ②指标与备注声称相反的运行清单 ③三条下周建议的消融/实验（各带运行编号依据）。",
        完整提示词: [
          "你是实验记录的复盘员。字段含义：cfg_hash（配置文件哈希前 12 位）、commit（代码短提交号）、",
          "data_ver（数据版本标识）、seed（随机种子）、metric_main（主指标名与数值）、note（一句话动机 + 一句话观察）。",
          "",
          "【任务】基于本周记录，输出三件事：",
          "1. 按配置聚类，报告最好的三个配置及它们的共性；",
          "2. 列出指标与备注声称相反的运行（备注说好、指标却没上去，或反之）；",
          "3. 提出三条下周建议的消融/实验。",
          "",
          "【硬约束】",
          "- 你只做模式识别，不做因果判断：所有「共性」都要标注为「相关，非因果」；",
          "- 指出每条结论依据的具体运行编号，便于我回表核对；",
          "- 若某条结论的依据不足（样本少于 3 条），明确写「依据不足」；",
          "- 不许给出「建议进一步研究」这类没有动作的建议。",
        ].join("\n"),
        版本: 1,
        状态: "可用",
        关联记录: "第 15 讲 §6 站内智能体（原文 Listing 15.2）",
      },
    ],
  },

  // ------------------------------------------------------------ 假设登记
  {
    key: "hypotheses",
    name: "假设登记",
    fields: [
      { name: "编号", type: "auto_number", prefix: "H-" },
      { name: "假设陈述", type: "long_text" },
      { name: "条件", type: "text" },
      { name: "方法", type: "text" },
      { name: "基线", type: "text" },
      { name: "指标", type: "text" },
      { name: "幅度", type: "text" },
      { name: "机制", type: "text" },
      {
        name: "要素齐备",
        type: "formula",
        formula: 'IF(AND(条件<>"", 方法<>"", 基线<>"", 指标<>"", 幅度<>"", 机制<>""), "六项齐全", "缺项待补")',
        note: "设计文档给的两个等价方案（单选 / 公式）里选公式：六要素缺一即自动判「缺项待补」，不需要人维护状态。",
      },
      { name: "可证伪条件", type: "long_text" },
      { name: "优先级", type: "rating", max: 5 },
      { name: "排序依据", type: "long_text" },
      {
        name: "状态",
        type: "single_select",
        options: ["待审查", "审查中", "已收紧待验证", "验证中", "得到支持", "已证伪", "搁置"],
      },
      { name: "风险备注", type: "long_text" },
      { name: "基线强度自查", type: "single_select", options: ["已核对是最强基线", "基线偏弱需更换", "未核对"] },
      { name: "证伪记录", type: "long_text" },
      { name: "审定状态", type: "single_select", options: ["待审定", "已审定", "退回"] },
      { name: "审定人", type: "person" },
      { name: "审定时间", type: "date" },
    ],
    views: [
      { name: "假设看板", type: "kanban", groupField: "状态" },
      { name: "要素缺项", type: "grid", filters: [{ field: "要素齐备", op: "eq", value: "缺项待补" }] },
      {
        name: "待验证",
        type: "grid",
        filters: [{ field: "状态", op: "eq", value: "已收紧待验证" }],
        sorts: [{ field: "优先级", direction: "desc" }],
      },
      { name: "已证伪档案", type: "grid", filters: [{ field: "状态", op: "eq", value: "已证伪" }] },
      {
        name: "基线自欺检查",
        type: "grid",
        filters: [{ field: "基线强度自查", op: "neq", value: "已核对是最强基线" }],
      },
    ],
    automations: [
      {
        name: "证伪即入档",
        trigger: { type: "field_equals", field: "状态", value: "已证伪" },
        actions: [
          {
            type: "add_comment",
            body:
              "已证伪假设保留不删：请补齐证伪记录（被哪个实验、什么结果），它是防止重复提出同类假设的资产。",
          },
          { type: "set_field", field: "优先级", value: "1" },
        ],
      },
      {
        name: "缺证伪条件不放行",
        trigger: { type: "record_created" },
        conditions: [{ field: "可证伪条件", op: "is_empty" }],
        actions: [
          { type: "add_comment", body: "写不出「什么结果会让我放弃它」，这条假设还没有出生。" },
        ],
        manualTodo: "设计里还带一个 notify（指定接收人）；通知中心前端已下线，且接收人需显式指定，留待确认接收人后补。",
      },
      {
        name: "六要素缺项提醒",
        trigger: { type: "field_equals", field: "要素齐备", value: "缺项待补" },
        actions: [
          { type: "add_comment", body: "对照六要素句式通读一遍：缺的那一项就是实验设计会踩的坑。" },
        ],
      },
      {
        name: "三轮未齐提醒",
        trigger: { type: "field_equals", field: "状态", value: "已收紧待验证" },
        actions: [
          {
            type: "add_comment",
            body: "三轮对抗审查还没齐：第一轮可证伪性、第二轮机制攻击、第三轮审稿人模拟。",
          },
        ],
        manualTodo:
          "设计里的附加条件「红队审查 关联数 < 3」表达不了（过滤/条件没有关联计数操作符），等 `09 红队审查` 表建好后用视图承接未齐清单。",
      },
    ],
    deferred: [
      { field: "来源", target: "02 差异假设 / 03 可行性冲刺" },
      { field: "关联配置", target: "配置台账" },
      { field: "关联段落", target: "17 段落卡" },
    ],
  },

  // ------------------------------------------------------------ 01 问题矩阵
  {
    key: "matrix",
    name: "01 问题矩阵",
    fields: [
      { name: "交叉点", type: "text" },
      {
        name: "横轴-技术路线",
        type: "single_select",
        options: ["提示工程", "SFT", "RAG", "Agent 工作流"],
        note: "设计文档给的初始选项「…按课题即时增补」，其余留空由使用时增补。",
      },
      {
        name: "纵轴-应用场景",
        type: "single_select",
        options: ["自动驾驶", "医疗影像", "工业质检", "金融合规", "边缘场景"],
      },
      { name: "是否冷门维度", type: "checkbox" },
      { name: "代表工作", type: "long_text" },
      { name: "公开数据集", type: "long_text" },
      { name: "常用指标", type: "long_text" },
      { name: "研究饱和度", type: "rating", max: 5 },
      { name: "数据算力可及性", type: "rating", max: 5 },
      { name: "一句话瓶颈", type: "text" },
      { name: "个人匹配度", type: "single_select", options: ["高", "中", "低"] },
      { name: "生成方式", type: "single_select", options: ["AI 生成", "人工补充", "人工核验后修改"] },
      { name: "核实状态", type: "single_select", options: ["待核实", "已核实", "存疑", "查无出处"] },
      { name: "核实人", type: "person" },
      { name: "核实时间", type: "date" },
      { name: "创建时间", type: "created_time", note: "待核实清单按创建时间升序 + 超 7 天标黄，需要这个系统字段。" },
      { name: "审定状态", type: "single_select", options: ["待审定", "已审定", "退回"] },
      { name: "审定人", type: "person" },
      { name: "审定时间", type: "date" },
    ],
    links: [{ name: "关联假设", type: "link", linkTable: "hypotheses" }],
    views: [
      {
        name: "矩阵总览",
        type: "grid",
        groups: ["横轴-技术路线", "纵轴-应用场景"],
        rowHeight: "short",
        hiddenFields: ["审定状态", "审定人", "审定时间"],
      },
      {
        name: "优先候选",
        type: "grid",
        filters: [
          { field: "研究饱和度", op: "lte", value: "2" },
          { field: "数据算力可及性", op: "gte", value: "4" },
          { field: "核实状态", op: "eq", value: "已核实" },
        ],
        sorts: [
          { field: "数据算力可及性", direction: "desc" },
          { field: "研究饱和度", direction: "asc" },
        ],
      },
      {
        name: "待核实清单",
        type: "grid",
        filters: [{ field: "核实状态", op: "eq", value: "待核实" }],
        sorts: [{ field: "创建时间", direction: "asc" }],
        rowHeight: "short",
        colorRules: [{ field: "创建时间", op: "lte", value: "today-7", color: "yellow", target: "row" }],
      },
      {
        name: "反共识边角",
        type: "grid",
        conjunction: "or",
        filters: [
          { field: "是否冷门维度", op: "eq", value: "true" },
          { field: "研究饱和度", op: "eq", value: "5" },
        ],
        colorRules: [{ field: "个人匹配度", op: "eq", value: "高", color: "green", target: "cell" }],
        note:
          "设计原文是「冷门维度=勾选 或（饱和度=5 且 个人匹配度=高）」的嵌套条件；过滤器只支持一层 and/or，这里退化为「冷门维度 或 饱和度=5」，并用颜色规则把「个人匹配度=高」标绿补偿。",
      },
      {
        name: "查无出处",
        type: "gallery",
        filters: [{ field: "核实状态", op: "eq", value: "查无出处" }],
      },
      {
        name: "批量补格",
        type: "form",
        hiddenFields: [
          "是否冷门维度",
          "研究饱和度",
          "数据算力可及性",
          "个人匹配度",
          "生成方式",
          "核实状态",
          "核实人",
          "核实时间",
          "创建时间",
          "审定状态",
          "审定人",
          "审定时间",
          "关联假设",
        ],
      },
    ],
    automations: [
      {
        name: "新增即待核实",
        trigger: { type: "record_created" },
        conditions: [{ field: "生成方式", op: "eq", value: "AI 生成" }],
        actions: [
          { type: "set_field", field: "核实状态", value: "待核实" },
          {
            type: "add_comment",
            body: "此单元格由 AI 生成，请核验至少 1 篇代表论文是否存在后再改状态。",
          },
        ],
      },
      {
        name: "待核实积压提醒",
        trigger: { type: "schedule", cron: "daily:09:00" },
        actions: [
          {
            type: "feishu_bot",
            text: "今日待核实清单见 `01 问题矩阵` 的 `待核实清单` 视图",
          },
        ],
        manualTodo:
          "设计里还有 run_agent（逐条留言并报数）；站内智能体只能由管理员创建，等 `问题地图纠偏员` 建好后把这条自动化补成两个动作。",
      },
      {
        name: "核验通过即建立证据链",
        trigger: { type: "field_equals", field: "核实状态", value: "已核实" },
        conditions: [{ field: "代表工作", op: "is_not_empty" }],
        actions: [
          {
            type: "add_comment",
            body: "代表工作已核实：请把它们登记进 `文献库`（第 5–6 讲的文献资产），让单元格与文献互相指得回去。",
          },
        ],
      },
    ],
    deferred: [{ field: "关联假设", target: "02 差异假设（本批先建成指向 `假设登记`）" }],
  },

  // ------------------------------------------------------------ 文献库
  {
    key: "library",
    name: "文献库",
    fields: [
      { name: "标题", type: "text" },
      { name: "作者", type: "text" },
      { name: "年份", type: "number" },
      { name: "发表处", type: "text" },
      { name: "DOI", type: "text", unique: true, note: "文本唯一值约束（2026-10-19 落地），需要新版服务端，否则唯一性会被静默忽略。" },
      { name: "链接", type: "url" },
      { name: "PDF", type: "attachment" },
      { name: "种子论文", type: "checkbox" },
      { name: "种子来源与入选理由", type: "long_text" },
      { name: "阅读级别", type: "single_select", options: ["未读", "泛读", "精读", "已复现", "弃读"] },
      { name: "淘汰理由", type: "text" },
      { name: "问题", type: "long_text" },
      { name: "假设", type: "long_text" },
      { name: "方法", type: "long_text" },
      { name: "证据", type: "long_text" },
      { name: "局限", type: "long_text", note: "红线：此栏必须手写，AI 不得代劳。" },
      { name: "关键数字", type: "text" },
      { name: "可复用部件", type: "long_text" },
      { name: "怀疑点", type: "long_text" },
      { name: "主题", type: "multi_select", note: "词表来自第 08 讲 `08 主题索引`，本批留空，建成主题索引后回填。" },
      { name: "复现结论", type: "single_select", options: ["可复现", "部分可复现", "不可复现", "未检查"] },
      { name: "AI 起草栏位", type: "multi_select", options: ["问题", "假设", "方法", "证据"] },
      { name: "人力核实", type: "checkbox" },
      { name: "入库日期", type: "date" },
      { name: "最近更新", type: "date" },
      { name: "创建时间", type: "created_time", note: "未核实项视图的颜色规则要用（超 14 天标红）。" },
      { name: "审定状态", type: "single_select", options: ["待审定", "已审定", "退回"] },
      { name: "审定人", type: "person" },
      { name: "审定时间", type: "date" },
    ],
    views: [
      {
        name: "待判决",
        type: "grid",
        filters: [{ field: "阅读级别", op: "eq", value: "未读" }],
        rowHeight: "short",
      },
      {
        name: "精读队列",
        type: "grid",
        filters: [{ field: "阅读级别", op: "eq", value: "泛读" }],
        sorts: [{ field: "入库日期", direction: "asc" }],
      },
      {
        name: "泛读登记",
        type: "grid",
        filters: [{ field: "阅读级别", op: "eq", value: "泛读" }],
        hiddenFields: [
          "作者",
          "年份",
          "发表处",
          "DOI",
          "链接",
          "PDF",
          "种子论文",
          "种子来源与入选理由",
          "假设",
          "方法",
          "证据",
          "局限",
          "可复用部件",
          "怀疑点",
          "主题",
          "AI 起草栏位",
          "人力核实",
          "入库日期",
          "最近更新",
          "创建时间",
          "审定状态",
          "审定人",
          "审定时间",
          "复现结论",
          "阅读级别",
          "淘汰理由",
        ],
      },
      {
        name: "弃读归档",
        type: "grid",
        filters: [{ field: "阅读级别", op: "eq", value: "弃读" }],
        groups: ["淘汰理由"],
      },
      {
        name: "未核实项",
        type: "grid",
        filters: [
          { field: "人力核实", op: "neq", value: "true" },
          { field: "证据", op: "is_not_empty" },
        ],
        colorRules: [{ field: "创建时间", op: "lte", value: "today-14", color: "red", target: "row" }],
        note:
          "设计原文是「人力核实未勾选 或 审定状态=待审定，且 证据非空」的嵌套条件；过滤器只支持一层 and/or，这里取「人力核实≠true 且 证据非空」（审定状态=待审定 但证据为空的行由 `幻觉隔离` 自动化降级提醒承接）。",
      },
      {
        name: "复现候选",
        type: "grid",
        filters: [
          { field: "阅读级别", op: "eq", value: "精读" },
          { field: "复现结论", op: "eq", value: "未检查" },
        ],
      },
      {
        name: "快速入库",
        type: "form",
        hiddenFields: [
          "PDF",
          "种子论文",
          "种子来源与入选理由",
          "阅读级别",
          "淘汰理由",
          "问题",
          "假设",
          "方法",
          "证据",
          "局限",
          "关键数字",
          "可复用部件",
          "怀疑点",
          "主题",
          "复现结论",
          "AI 起草栏位",
          "人力核实",
          "入库日期",
          "最近更新",
          "创建时间",
          "审定状态",
          "审定人",
          "审定时间",
        ],
      },
    ],
    automations: [
      {
        name: "精读即要求定位",
        trigger: { type: "field_equals", field: "阅读级别", value: "精读" },
        actions: [
          {
            type: "add_comment",
            body: "请确认：`证据` 栏每个数字都带定位（页码/表号）；`局限` 栏由你手写，不得由 AI 代劳。",
          },
        ],
      },
      {
        name: "幻觉隔离",
        trigger: { type: "record_created" },
        conditions: [{ field: "审定状态", op: "eq", value: "待审定" }],
        actions: [
          { type: "set_field", field: "阅读级别", value: "未读" },
          {
            type: "add_comment",
            body: "此条尚未核验来源，禁止进入综述与论文引用；核验后手动升为精读。",
          },
        ],
      },
      {
        name: "每周清理未核实项",
        trigger: { type: "schedule", cron: "weekly:5:17:00" },
        actions: [
          { type: "feishu_bot", text: "本周未核实项见 `文献库` 的 `未核实项` 视图，请逐条核验或退回" },
        ],
        manualTodo:
          "设计里还有 run_agent（逐条留言「本周内完成核验或退回」）+ notify（指定接收人）；等 `预读出题机` 之外的清理智能体确定、接收人确认后补齐。",
      },
      {
        name: "弃读缺理由",
        trigger: { type: "field_equals", field: "阅读级别", value: "弃读" },
        conditions: [{ field: "淘汰理由", op: "is_empty" }],
        actions: [
          {
            type: "add_comment",
            body: "淘汰理由是一笔资产：写清为什么像但不同，它是下次检索的边界知识。",
          },
        ],
      },
    ],
    deferred: [
      { field: "检索来源", target: "05 检索日志" },
      { field: "关联关系", target: "08 文献关系" },
    ],
  },

  // ------------------------------------------------------------ 实验记录
  {
    key: "runs",
    name: "实验记录",
    fields: [
      { name: "运行编号", type: "auto_number", prefix: "run-" },
      { name: "配置哈希", type: "text" },
      { name: "代码提交", type: "text" },
      { name: "数据版本", type: "text", note: "设计允许「关联 `14 数据资产` 或文本」，本批用文本，等 14 讲建表后改为关联。" },
      { name: "随机种子", type: "number" },
      { name: "指标", type: "long_text" },
      { name: "备注", type: "long_text" },
      { name: "指标预声明", type: "checkbox" },
      { name: "状态", type: "single_select", options: ["运行中", "完成", "失败", "中断"] },
      { name: "耗时（小时）", type: "number" },
      { name: "开始时间", type: "date" },
      { name: "结束时间", type: "date" },
      { name: "结论方向", type: "single_select", options: ["支持假设", "不支持", "不确定", "仅调试"] },
      { name: "异常现象", type: "long_text" },
      { name: "审定状态", type: "single_select", options: ["待审定", "已审定", "退回"] },
      { name: "审定人", type: "person" },
      { name: "审定时间", type: "date" },
    ],
    links: [{ name: "关联假设", type: "link", linkTable: "hypotheses" }],
    views: [
      { name: "缺配置哈希", type: "grid", filters: [{ field: "配置哈希", op: "is_empty" }] },
      { name: "缺提交号", type: "grid", filters: [{ field: "代码提交", op: "is_empty" }] },
      { name: "缺数据版本", type: "grid", filters: [{ field: "数据版本", op: "is_empty" }] },
      { name: "缺种子", type: "grid", filters: [{ field: "随机种子", op: "is_empty" }] },
      { name: "缺指标", type: "grid", filters: [{ field: "指标", op: "is_empty" }] },
      { name: "备注为空", type: "grid", filters: [{ field: "备注", op: "is_empty" }] },
      { name: "支持与不支持", type: "grid", groups: ["结论方向"] },
      { name: "未预声明", type: "grid", filters: [{ field: "指标预声明", op: "neq", value: "true" }] },
      {
        name: "本周运行",
        type: "grid",
        filters: [
          { field: "开始时间", op: "gte", value: "week_start" },
          { field: "开始时间", op: "lte", value: "week_end" },
        ],
      },
      { name: "异常现象池", type: "grid", filters: [{ field: "异常现象", op: "is_not_empty" }] },
      {
        name: "运行档案",
        type: "grid",
        filters: [{ field: "状态", op: "eq", value: "完成" }],
        sorts: [{ field: "开始时间", direction: "desc" }],
      },
    ],
    automations: [
      {
        name: "六字段缺失即提醒",
        trigger: { type: "record_created" },
        actions: [{ type: "add_comment", body: "（占位）六字段完整性由智能体逐条点名。" }],
        manualTodo:
          "设计用 run_agent（智能体检查六字段缺哪个并点名）；站内智能体只能由管理员创建，等 `六字段巡检员` 建好后替换占位动作。",
      },
      {
        name: "运行前固化指纹",
        trigger: { type: "field_equals", field: "状态", value: "运行中" },
        conditions: [
          { field: "配置哈希", op: "is_empty" },
          { field: "代码提交", op: "is_empty" },
        ],
        conjunction: "or",
        actions: [
          { type: "add_comment", body: "指纹先于运行：提交号与哈希应在实验开始前固化。" },
        ],
      },
      {
        name: "未预声明即提醒",
        trigger: { type: "field_equals", field: "状态", value: "完成" },
        conditions: [{ field: "指标预声明", op: "neq", value: "true" }],
        actions: [
          {
            type: "add_comment",
            body:
              "这次运行没有预声明指标：它的数字只能作为线索，不能作为结论；下次运行前先写清看哪个指标、期望朝哪个方向变。",
          },
        ],
        manualTodo:
          "设计原文的触发器是 `field_equals`（指标预声明=未勾选）；复选框空值与 false 无法被 field_equals 稳定命中，改为在 `状态=完成` 时用条件 `指标预声明 ≠ true` 判定（语义等价）。",
      },
      {
        name: "周五 AI 复盘",
        trigger: { type: "schedule", cron: "weekly:5:17:00" },
        actions: [{ type: "feishu_bot", text: "本周复盘待逐条核对：`15 AI 复盘` 的 `未核对` 视图" }],
        manualTodo:
          "设计里的主动作是 run_agent（每周复盘员，tools 模式，写 `15 AI 复盘`）；`15 AI 复盘` 表与智能体都不在本批，等建好后补齐。",
      },
    ],
    deferred: [
      { field: "配置", target: "配置台账" },
      { field: "关联图表", target: "18 图表台账" },
    ],
  },
];

// ---------------------------------------------------------------- HTTP 客户端

const log = (message: string) => console.log(message);
const todo: string[] = [];
const warn = (message: string) => {
  console.warn(`  ! ${message}`);
  todo.push(message);
};

/**
 * dry-run 的内存影子库：预演时写请求不落库，但后续步骤还要读回刚建的表/字段/视图，
 * 拿假 id 去真实例上查只会 404。这里用影子状态承接建表流程，让预演能一路走完。
 */
type DryTable = {
  id: string;
  name: string;
  fields: Array<{ id: string; name: string; type: string }>;
  views: Array<{ id: string; name: string; type: string }>;
  records: Array<{ id: string; fields: Record<string, any> }>;
};
const dryTables = new Map<string, DryTable>();
const dryViewOwner = new Map<string, string>();
const dryBases: Array<{ id: string; name: string; tables: Array<{ id: string; name: string }> }> = [];
let drySeq = 0;
const dryId = (prefix: string) => `${prefix}_dry${++drySeq}`;

function dryRunWrite(method: string, path: string, body: any): any {
  let m: RegExpMatchArray | null;
  if (method === "POST" && (m = path.match(/^\/api\/bases$/))) {
    const base = { id: dryId("b"), name: String(body?.name ?? ""), tables: [] };
    dryBases.push(base);
    return { id: base.id };
  }
  if (method === "POST" && (m = path.match(/^\/api\/bases\/([^/]+)\/tables$/))) {
    const id = dryId("t");
    const table: DryTable = {
      id,
      name: String(body?.name ?? ""),
      fields: (body?.fields ?? []).map((field: any) => ({ id: dryId("f"), name: field.name, type: field.type })),
      views: [{ id: dryId("v"), name: String(body?.defaultViewName ?? "表格"), type: "grid" }],
      records: [],
    };
    dryTables.set(id, table);
    const base = dryBases.find((item) => item.id === m![1]);
    base?.tables.push({ id, name: table.name });
    return { id };
  }
  if (method === "POST" && (m = path.match(/^\/api\/tables\/([^/]+)\/fields$/))) {
    const id = dryId("f");
    dryTables.get(m[1])?.fields.push({ id, name: body?.name, type: body?.type });
    return { id };
  }
  if (method === "POST" && (m = path.match(/^\/api\/tables\/([^/]+)\/views$/))) {
    const id = dryId("v");
    dryTables.get(m[1])?.views.push({ id, name: body?.name, type: body?.type });
    dryViewOwner.set(id, m[1]);
    return { id };
  }
  if (method === "DELETE" && (m = path.match(/^\/api\/views\/([^/]+)$/))) {
    const tableId = dryViewOwner.get(m[1]);
    const table = tableId ? dryTables.get(tableId) : undefined;
    if (table) table.views = table.views.filter((view) => view.id !== m[1]);
    dryViewOwner.delete(m[1]);
    return { ok: true };
  }
  if (method === "POST" && (m = path.match(/^\/api\/tables\/([^/]+)\/records$/))) {
    const id = dryId("r");
    dryTables.get(m[1])?.records.push({ id, fields: body?.fields ?? {} });
    return { id };
  }
  // 其余写请求（视图 config 收敛、自动化创建等）不改变影子状态的结构，返回通用成功体。
  return { __dryRun: true, id: dryId("x") };
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  if (DRY_RUN) {
    if (method !== "GET") {
      log(`    [dry-run] ${method} ${path}`);
      return dryRunWrite(method, path, body);
    }
    if (path === "/api/bases" && dryBases.length) return dryBases;
    const m = path.match(/^\/api\/tables\/([^/]+)(\/automations)?$/);
    if (m && dryTables.has(m[1])) return m[2] ? [] : dryTables.get(m[1]);
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${method} ${path} → HTTP ${res.status}：${detail}`);
  }
  return data;
}

// ---------------------------------------------------------------- 表状态缓存

type TableState = {
  id: string;
  name: string;
  fields: Array<{ id: string; name: string; type: string }>;
  views: Array<{ id: string; name: string; type: string; config?: Record<string, any> }>;
  records: Array<{ id: string; fields: Record<string, any> }>;
};

async function loadTable(tableId: string): Promise<TableState> {
  const payload = await api("GET", `/api/tables/${tableId}`);
  return {
    id: payload.id,
    name: payload.name,
    fields: (payload.fields ?? []).map((field: any) => ({ id: field.id, name: field.name, type: field.type })),
    views: (payload.views ?? []).map((view: any) => ({
      id: view.id,
      name: view.name,
      type: view.type,
      config: view.config,
    })),
    records: (payload.records ?? []).map((record: any) => ({ id: record.id, fields: record.fields ?? {} })),
  };
}

function fieldIdOf(state: TableState, name: string): string {
  const field = state.fields.find((item) => item.name === name);
  if (!field) throw new Error(`表 ${state.name} 里找不到字段：${name}`);
  return field.id;
}

// ---------------------------------------------------------------- 各阶段执行

async function resolveBase(): Promise<string> {
  const bases: Array<{ id: string; name: string }> = await api("GET", "/api/bases");
  const hit = bases.find((base) => base.name === BASE_NAME);
  if (hit) return hit.id;
  if (!CREATE_BASE) {
    throw new Error(
      `空间「${BASE_NAME}」不存在。Agent 令牌不能建库：请在管理端先建好这个空库（或改用管理员令牌并加 --create-base）。`,
    );
  }
  log(`  创建空间「${BASE_NAME}」`);
  const created = await api("POST", "/api/bases", { name: BASE_NAME });
  return created.id;
}

/**
 * 建表接口把默认视图写死为 grid，而视图类型创建后不可修改（`PATCH /api/views/:id` 只收 name / config）。
 * 所以首视图若本就不是 grid（如 `假设登记` 的 `假设看板`），不能借默认视图实现：建表时用一个占位名，
 * 首视图交给 ensureViews 按声明的类型新建，占位视图随后删除。
 */
const PLACEHOLDER_VIEW_NAME = "__建表占位视图__";

async function createTableWithFields(baseId: string, spec: TableSpec): Promise<TableState> {
  const created = await api("POST", `/api/bases/${baseId}/tables`, {
    name: spec.name,
    fields: spec.fields.map((field) => fieldDraft(field)),
    defaultViewName: PLACEHOLDER_VIEW_NAME,
  });
  return loadTable(created.id);
}

/** 建表占位视图的清理：真实视图都已建好后再删，避免撞上「至少保留一个视图」。 */
async function dropPlaceholderView(state: TableState): Promise<void> {
  const placeholder = state.views.find((view) => view.name === PLACEHOLDER_VIEW_NAME);
  if (!placeholder || state.views.length <= 1) return;
  log(`    - 删除建表占位视图（首视图已按声明类型另建）`);
  await api("DELETE", `/api/views/${placeholder.id}`);
  state.views = (await loadTable(state.id)).views;
}

function fieldDraft(field: FieldSpec): Record<string, unknown> {
  const draft: Record<string, unknown> = { name: field.name, type: field.type };
  if (field.options) draft.options = field.options;
  if (field.max) draft.max = field.max;
  if (field.prefix) draft.prefix = field.prefix;
  if (field.formula) draft.formula = field.formula;
  if (field.unique) draft.unique = true;
  if (field.linkTable) {
    const targetId = tableIds.get(field.linkTable);
    if (!targetId) throw new Error(`关联字段 ${field.name} 的目标表 ${field.linkTable} 还没建`);
    draft.linkTableId = targetId;
  }
  return draft;
}

async function ensureFields(state: TableState, fields: FieldSpec[]): Promise<void> {
  for (const field of fields) {
    if (state.fields.some((item) => item.name === field.name)) {
      log(`    · 字段已存在：${field.name}`);
      continue;
    }
    log(`    + 字段：${field.name}（${field.type}）`);
    await api("POST", `/api/tables/${state.id}/fields`, fieldDraft(field));
  }
  state.fields = (await loadTable(state.id)).fields;
}

/** 建视图的请求体：类型相关的参数在这里一次给全（视图类型创建后不可更改）。
 *  接口按字段 id 或唯一字段名解析，spec 里写的是字段名。 */
function viewDraftPayload(view: ViewSpec): Record<string, unknown> {
  return {
    name: view.name,
    type: view.type,
    ...(view.groupField ? { groupField: view.groupField } : {}),
    ...(view.dateField ? { dateField: view.dateField } : {}),
  };
}

/** 视图配置的期望值：建视图与校验共用同一套构造逻辑，避免两边口径漂移。 */
function expectedViewConfig(state: TableState, view: ViewSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (view.filters?.length) {
    config.filters = view.filters.map((filter) => ({
      fieldId: fieldIdOf(state, filter.field),
      op: filter.op,
      ...(filter.value === undefined ? {} : { value: filter.value }),
    }));
    config.conjunction = view.conjunction ?? "and";
  }
  if (view.sorts?.length) {
    config.sorts = view.sorts.map((sort) => ({
      fieldId: fieldIdOf(state, sort.field),
      direction: sort.direction,
    }));
  }
  if (view.groups?.length) {
    config.groups = view.groups.map((name) => ({ fieldId: fieldIdOf(state, name) }));
  }
  if (view.hiddenFields?.length) {
    config.hiddenFieldIds = view.hiddenFields.map((name) => fieldIdOf(state, name));
  }
  if (view.rowHeight) config.rowHeight = view.rowHeight;
  if (view.groupField) config.groupFieldId = fieldIdOf(state, view.groupField);
  if (view.dateField) config.dateFieldId = fieldIdOf(state, view.dateField);
  if (view.colorRules?.length) {
    config.colorRules = view.colorRules.map((rule, index) => ({
      id: `cr_${index + 1}`,
      fieldId: fieldIdOf(state, rule.field),
      op: rule.op,
      ...(rule.value === undefined ? {} : { value: rule.value }),
      color: rule.color,
      target: rule.target ?? "row",
    }));
  }
  return config;
}

async function ensureViews(state: TableState, views: ViewSpec[]): Promise<void> {
  for (const view of views) {
    const matched = state.views.find((item) => item.name === view.name);
    let viewId: string;
    if (matched && matched.type !== view.type) {
      // 视图类型创建后不可改：先按正确类型新建，再删掉类型不符的旧视图。
      log(`    ! 视图类型不符，重建为 ${view.type}：${view.name}（原为 ${matched.type}）`);
      const rebuilt = await api("POST", `/api/tables/${state.id}/views`, viewDraftPayload(view));
      await api("DELETE", `/api/views/${matched.id}`);
      viewId = rebuilt.id;
    } else if (matched) {
      viewId = matched.id;
      log(`    · 视图已存在，收敛配置：${view.name}`);
    } else {
      log(`    + 视图：${view.name}（${view.type}）`);
      const created = await api("POST", `/api/tables/${state.id}/views`, viewDraftPayload(view));
      viewId = created.id;
    }
    const config = expectedViewConfig(state, view);
    if (Object.keys(config).length) await api("PATCH", `/api/views/${viewId}`, { config });
  }
  state.views = (await loadTable(state.id)).views;
}

async function ensureAutomations(state: TableState, automations: AutomationSpec[]): Promise<void> {
  if (!automations.length) return;
  const existing: Array<{ id: string; name: string }> = await api("GET", `/api/tables/${state.id}/automations`);
  for (const automation of automations) {
    if (automation.manualTodo) {
      warn(`自动化「${automation.name}」未完全落地：${automation.manualTodo}`);
      for (const action of automation.actions) {
        if (action.type === "run_agent") throw new Error(`自动化「${automation.name}」含 run_agent，需要真实 agentId`);
      }
    }
    if (existing.some((item) => item.name === automation.name)) {
      log(`    · 自动化已存在：${automation.name}`);
      continue;
    }
    const trigger =
      automation.trigger.type === "field_equals"
        ? { type: "field_equals", fieldId: fieldIdOf(state, automation.trigger.field), value: automation.trigger.value }
        : automation.trigger.type === "record_updated" && automation.trigger.field
          ? { type: "record_updated", fieldId: fieldIdOf(state, automation.trigger.field) }
          : automation.trigger;
    const actions = automation.actions.map((action) => {
      if (action.type === "set_field") {
        return { type: "set_field", fieldId: fieldIdOf(state, action.field), value: action.value };
      }
      return action;
    });
    const conditions = automation.conditions?.map((condition) => ({
      fieldId: fieldIdOf(state, condition.field),
      op: condition.op,
      ...(condition.value === undefined ? {} : { value: condition.value }),
    }));
    if (automation.conjunction === "or" && conditions?.length) {
      // 条件默认 AND 求值；OR 语义靠自动化条件的 conjunction 不存在的现状拆不开，
      // 因此这类条件用多条自动化或退化表达——这里只提醒，不静默改变语义。
      warn(`自动化「${automation.name}」原文条件是 OR 语义（${conditions.length} 条），系统条件为 AND 求值，当前等价近似。`);
    }
    log(`    + 自动化：${automation.name}`);
    await api("POST", `/api/tables/${state.id}/automations`, {
      name: automation.name,
      trigger,
      actions,
      ...(conditions?.length ? { conditions } : {}),
      enabled: true,
    });
  }
}

async function ensureSeedRecords(state: TableState, records: Array<Record<string, unknown>>): Promise<void> {
  if (!records?.length) return;
  const existing = new Set(state.records.map((record) => String(record.fields["名称"] ?? "")));
  for (const record of records) {
    const name = String(record["名称"] ?? "");
    if (existing.has(name)) {
      log(`    · 种子记录已存在：${name}`);
      continue;
    }
    log(`    + 种子记录：${name}`);
    await api("POST", `/api/tables/${state.id}/records`, { fields: record });
  }
}

// ---------------------------------------------------------------- 回读校验

/** 回读线上实例，与 spec 声明逐项比对；`--verify` 只读不写。 */
async function verifyTables(selected: TableSpec[], baseId: string): Promise<number> {
  let mismatches = 0;
  const fail = (message: string) => {
    mismatches += 1;
    log(`    ! ${message}`);
  };
  const bases: Array<{ id: string; name: string; tables: Array<{ id: string; name: string }> }> = await api("GET", "/api/bases");
  const base = bases.find((item) => item.id === baseId);
  const totals = { fields: 0, views: 0, automations: 0, seeds: 0 };

  for (const spec of selected) {
    log(`\n[表] ${spec.name}`);
    const listed = base?.tables.find((table) => table.name === spec.name);
    if (!listed) {
      fail("表不存在");
      continue;
    }
    const state = await loadTable(listed.id);
    const declaredFields = [...spec.fields, ...(spec.links ?? [])];

    for (const field of declaredFields) {
      const actual = state.fields.find((item) => item.name === field.name);
      if (!actual) fail(`字段缺失：${field.name}`);
      else if (actual.type !== field.type) fail(`字段类型不符：${field.name}（期望 ${field.type} / 实际 ${actual.type}）`);
    }

    for (const view of spec.views) {
      const actual = state.views.find((item) => item.name === view.name);
      if (!actual) {
        fail(`视图缺失：${view.name}`);
        continue;
      }
      if (actual.type !== view.type) fail(`视图类型不符：${view.name}（期望 ${view.type} / 实际 ${actual.type}）`);
      for (const [key, value] of Object.entries(expectedViewConfig(state, view))) {
        const got = actual.config?.[key];
        if (JSON.stringify(got) !== JSON.stringify(value)) {
          fail(
            `视图配置不符：${view.name}.${key}（期望 ${JSON.stringify(value)} / 实际 ${JSON.stringify(got)}）`,
          );
        }
      }
    }

    const automations: Array<{ name: string }> = await api("GET", `/api/tables/${state.id}/automations`);
    for (const automation of spec.automations) {
      if (!automations.some((item) => item.name === automation.name)) fail(`自动化缺失：${automation.name}`);
    }

    for (const record of spec.seedRecords ?? []) {
      const name = String(record["名称"] ?? "");
      if (!state.records.some((item) => String(item.fields["名称"] ?? "") === name)) fail(`种子记录缺失：${name}`);
    }

    totals.fields += state.fields.length;
    totals.views += state.views.length;
    totals.automations += automations.length;
    totals.seeds += state.records.length;
    log(
      `  · 字段 ${state.fields.length} / 视图 ${state.views.length} / 自动化 ${automations.length} / 种子 ${state.records.length}`,
    );
    const extras = {
      fields: state.fields.filter((field) => !declaredFields.some((item) => item.name === field.name)).map((f) => f.name),
      views: state.views.filter((view) => !spec.views.some((item) => item.name === view.name)).map((v) => v.name),
      automations: automations.filter((item) => !spec.automations.some((a) => a.name === item.name)).map((a) => a.name),
    };
    if (extras.fields.length) {
      log(`  · 声明外字段（含本批延后未建的 ${(spec.deferred ?? []).length} 个）：${extras.fields.join("、")}`);
    }
    if (extras.views.length) log(`  · 声明外视图：${extras.views.join("、")}`);
    if (extras.automations.length) log(`  · 声明外自动化：${extras.automations.join("、")}`);
  }

  log(`\n合计：字段 ${totals.fields} / 视图 ${totals.views} / 自动化 ${totals.automations} / 种子 ${totals.seeds}`);
  return mismatches;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  log(`目标实例：${BASE_URL}${DRY_RUN ? "（dry-run）" : ""}`);
  log(`目标空间：${BASE_NAME}`);
  const baseId = await resolveBase();
  log(`空间 id：${baseId}`);

  const selected = SPEC.filter((table) => !ONLY.length || ONLY.includes(table.key));

  if (VERIFY) {
    const mismatches = await verifyTables(selected, baseId);
    log(mismatches ? `\n校验不通过：${mismatches} 项与声明不一致。` : "\n校验通过：线上落库与声明一致。");
    process.exit(mismatches ? 1 : 0);
  }

  // 阶段一：建表 + 建非关联字段
  for (const spec of selected) {
    log(`\n[表] ${spec.name}`);
    const bases: Array<{ id: string; name: string; tables: Array<{ id: string; name: string }> }> = await api("GET", "/api/bases");
    const base = bases.find((item) => item.id === baseId);
    const existing = base?.tables.find((table) => table.name === spec.name);
    let state: TableState;
    if (existing) {
      log(`  · 表已存在，跳过建表（字段与视图继续收敛）`);
      state = await loadTable(existing.id);
    } else {
      log(`  + 建表（${spec.fields.length} 个字段）`);
      state = await createTableWithFields(baseId, spec);
    }
    tableIds.set(spec.key, state.id);
    await ensureFields(state, spec.fields);
  }

  // 阶段二：关联字段（目标表已全部存在）
  for (const spec of selected) {
    if (!spec.links?.length) continue;
    const state = await loadTable(tableIds.get(spec.key)!);
    log(`\n[表] ${spec.name} · 关联字段`);
    await ensureFields(state, spec.links);
  }

  // 阶段三：视图与自动化
  for (const spec of selected) {
    const state = await loadTable(tableIds.get(spec.key)!);
    log(`\n[表] ${spec.name} · 视图`);
    await ensureViews(state, spec.views);
    await dropPlaceholderView(state);
    log(`\n[表] ${spec.name} · 自动化`);
    await ensureAutomations(state, spec.automations);
    if (spec.seedRecords) {
      log(`\n[表] ${spec.name} · 种子记录`);
      await ensureSeedRecords(await loadTable(state.id), spec.seedRecords);
    }
    for (const item of spec.deferred ?? []) {
      warn(`字段「${spec.name}.${item.field}」延后到后续批次：目标表 ${item.target} 尚未建成。`);
    }
  }

  log(`\n================ 汇总 ================`);
  log(`已建表：${selected.map((spec) => spec.name).join("、")}`);
  if (todo.length) {
    log(`\n待人工/后续处理的 ${todo.length} 项：`);
    for (const item of todo) log(`  - ${item}`);
  } else {
    log("没有未完成项。");
  }
}

await main().catch((error) => {
  console.error(`\n构建失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
