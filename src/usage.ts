import type { Client } from "@libsql/client";

/**
 * 轻量使用度量（对标复盘里的 P2-4.6）：
 * 按天（北京时间）聚合接口调用、Agent 调用、记录/文档写入与自动化运行，
 * 只在 usage_daily 里留一行/天，用来回答"哪些功能真的在被用"。
 *
 * 写入先在内存里攒批（每个请求都打一次库没必要），定时或攒够一批再 upsert；
 * 进程退出前的最后一批由 listen.ts 的收尾钩子 flush。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const USAGE_KINDS = [
  "api_calls",
  "agent_calls",
  "record_writes",
  "doc_writes",
  "automation_runs",
  "automation_failures",
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

export interface UsageDay {
  day: string;
  apiCalls: number;
  agentCalls: number;
  recordWrites: number;
  docWrites: number;
  automationRuns: number;
  automationFailures: number;
}

export interface UsageSummary {
  days: UsageDay[];
  totals: Omit<UsageDay, "day">;
}

/** 北京时间（UTC+8，无夏令时）的 YYYY-MM-DD。 */
export function shanghaiDay(from = Date.now()): string {
  return new Date(from + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export class UsageMetrics {
  private buffer = new Map<string, Map<UsageKind, number>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Client,
    private readonly flushMs = 10_000,
  ) {}

  /** 记一次用量；返回值无意义，失败只写日志，不影响主流程。 */
  bump(kind: UsageKind, count = 1, at = Date.now()): void {
    if (count <= 0) return;
    const day = shanghaiDay(at);
    const bucket = this.buffer.get(day) ?? new Map<UsageKind, number>();
    bucket.set(kind, (bucket.get(kind) ?? 0) + count);
    this.buffer.set(day, bucket);
    if (this.pending() >= 50) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  private pending(): number {
    let sum = 0;
    for (const bucket of this.buffer.values()) {
      for (const value of bucket.values()) sum += value;
    }
    return sum;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** 把内存增量写进 usage_daily；串行执行，避免并发 upsert 互相覆盖。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.size === 0) return;
    const batch = this.buffer;
    this.buffer = new Map();
    this.chain = this.chain
      .then(async () => {
        for (const [day, kinds] of batch) {
          const values = USAGE_KINDS.map((kind) => kinds.get(kind) ?? 0);
          await this.db.execute({
            sql: `INSERT INTO usage_daily (day, api_calls, agent_calls, record_writes, doc_writes, automation_runs, automation_failures, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(day) DO UPDATE SET
                    api_calls = api_calls + excluded.api_calls,
                    agent_calls = agent_calls + excluded.agent_calls,
                    record_writes = record_writes + excluded.record_writes,
                    doc_writes = doc_writes + excluded.doc_writes,
                    automation_runs = automation_runs + excluded.automation_runs,
                    automation_failures = automation_failures + excluded.automation_failures,
                    updated_at = excluded.updated_at`,
            args: [day, ...values, Date.now()],
          });
        }
      })
      .catch((error) => {
        console.error("usage flush failed", error);
      });
    await this.chain;
  }

  /** 近 N 天（含今天）的按天度量；没有数据的天补 0，方便直接出图/出表。 */
  async summary(days = 14, now = Date.now()): Promise<UsageSummary> {
    const span = Math.max(1, Math.min(90, Math.floor(days) || 14));
    const keys: string[] = [];
    for (let i = span - 1; i >= 0; i -= 1) keys.push(shanghaiDay(now - i * DAY_MS));
    await this.flush();
    const result = await this.db.execute({
      sql: "SELECT * FROM usage_daily WHERE day >= ? ORDER BY day ASC",
      args: [keys[0]],
    });
    const byDay = new Map(result.rows.map((row) => [String(row.day), row]));
    const rows: UsageDay[] = keys.map((day) => {
      const row = byDay.get(day);
      return {
        day,
        apiCalls: Number(row?.api_calls ?? 0),
        agentCalls: Number(row?.agent_calls ?? 0),
        recordWrites: Number(row?.record_writes ?? 0),
        docWrites: Number(row?.doc_writes ?? 0),
        automationRuns: Number(row?.automation_runs ?? 0),
        automationFailures: Number(row?.automation_failures ?? 0),
      };
    });
    const totals = rows.reduce(
      (sum, row) => ({
        apiCalls: sum.apiCalls + row.apiCalls,
        agentCalls: sum.agentCalls + row.agentCalls,
        recordWrites: sum.recordWrites + row.recordWrites,
        docWrites: sum.docWrites + row.docWrites,
        automationRuns: sum.automationRuns + row.automationRuns,
        automationFailures: sum.automationFailures + row.automationFailures,
      }),
      { apiCalls: 0, agentCalls: 0, recordWrites: 0, docWrites: 0, automationRuns: 0, automationFailures: 0 },
    );
    return { days: rows, totals };
  }
}
