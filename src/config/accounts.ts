import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAccountsDir } from "./paths.js";
import { loadSecureJson, saveSecureJson } from "./secureStore.js";
import { validateStorageId } from "./security.js";

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";

export interface AccountData {
  accountId: string;
  botToken: string;
  boundUserId: string;
  baseUrl: string;
  createdAt: string;
}

export function saveAccount(account: AccountData): void {
  validateStorageId(account.accountId, "accountId");
  saveSecureJson(accountPath(account.accountId), account);
}

export function loadAccount(accountId: string): AccountData | null {
  validateStorageId(accountId, "accountId");
  return loadSecureJson<AccountData | null>(accountPath(accountId), null);
}

export function loadLatestAccount(): AccountData | null {
  try {
    const files = readdirSync(getAccountsDir()).filter((file) => file.endsWith(".json"));
    let latest: { file: string; mtimeMs: number } | undefined;
    for (const file of files) {
      const stat = statSync(join(getAccountsDir(), file));
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stat.mtimeMs };
    }
    if (!latest) return null;
    return loadAccount(latest.file.replace(/\.json$/, ""));
  } catch {
    return null;
  }
}

function accountPath(accountId: string): string {
  validateStorageId(accountId, "accountId");
  return join(getAccountsDir(), `${accountId}.json`);
}
