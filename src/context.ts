import path from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "./accounts.js";
import { configureAgentRuntime } from "./agent-runtime.js";
import { BackupService } from "./backup.js";
import { Store } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const dataDir = path.join(root, "data");
export const store = new Store(path.join(dataDir, "duowei.db"));
export const accounts = new Accounts(store.database, store, dataDir);

export const backup = new BackupService(store.database, dataDir);

/** 智能体运行时：工具白名单 + 自动化动作 run_agent 的装配点 */
export const agentRuntime = configureAgentRuntime({ store, accounts });

export async function init(): Promise<void> {
  await store.init();
  await accounts.maybeBootstrapFromEnv();
  await backup.ensureTables();
}
