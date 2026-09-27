import path from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "./accounts.js";
import { Store } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const dataDir = path.join(root, "data");
export const store = new Store(path.join(dataDir, "duowei.db"));
export const accounts = new Accounts(store.database, store, dataDir);

export async function init(): Promise<void> {
  await store.init();
  await accounts.maybeBootstrapFromEnv();
}
