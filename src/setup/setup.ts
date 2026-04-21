import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";

import QRCode from "qrcode";

import { saveAccount } from "../config/accounts.js";
import { loadConfig, saveConfig } from "../config/config.js";
import { getDataDir } from "../config/paths.js";
import { checkCodexInstalled } from "../runtime/codexAvailability.js";
import { assertCodexLoggedIn, formatCodexLoginGuidance } from "../config/codexAuth.js";
import { assertGitRepo, resolveAllowedRepoRoot } from "../config/git.js";
import { startQrLogin, waitForQrScan } from "../wechat/login.js";

export async function runSetup(): Promise<void> {
  mkdirSync(getDataDir(), { recursive: true, mode: 0o700 });

  const codex = checkCodexInstalled();
  if (!codex.ok) {
    throw new Error(`未找到本机 codex CLI: ${codex.error}\n请先安装并登录 Codex CLI。`);
  }
  console.log(`已检测到 codex: ${codex.version || "installed"}`);
  const login = assertCodexLoggedIn();
  console.log(formatCodexLoginGuidance(login));

  const account = await bindWechat();
  saveAccount(account);
  console.log(`微信绑定成功，bound user id: ${account.boundUserId}`);

  const rl = createInterface({ input, output });
  try {
    const current = loadConfig();
    const answer = await rl.question(`默认工作目录 [${current.defaultCwd}]: `);
    const selectedCwd = await realpath(answer.trim() || current.defaultCwd);
    const defaultCwd = await assertGitRepo(selectedCwd);
    const rootsAnswer = await rl.question(`允许切换的 Git repo roots，逗号分隔 [${defaultCwd}]: `);
    const roots = (rootsAnswer.trim() ? rootsAnswer.split(",") : [defaultCwd]).map((root) => root.trim()).filter(Boolean);
    const allowlistRoots = await Promise.all(
      roots.map(async (root) => assertGitRepo(await realpath(root))),
    );
    await resolveAllowedRepoRoot(defaultCwd, allowlistRoots);
    saveConfig({ defaultCwd, allowlistRoots, streamIntervalMs: current.streamIntervalMs });
    console.log("配置已保存。运行 npm run start 前台启动，或 npm run daemon -- start 后台启动。");
  } finally {
    rl.close();
  }
}

async function bindWechat() {
  const qrPath = join(getDataDir(), "qrcode.png");
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();
    await QRCode.toFile(qrPath, qrcodeUrl, { width: 420, margin: 2 });
    openFile(qrPath);
    console.log(`请用微信扫描二维码: ${qrPath}`);
    console.log(`如果图片未打开，可手动打开该文件。`);
    try {
      const account = await waitForQrScan(qrcodeId);
      if (existsSync(qrPath)) unlinkSync(qrPath);
      return account;
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired")) {
        console.log("二维码已过期，正在刷新。");
        continue;
      }
      throw error;
    }
  }
}

function openFile(filePath: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  spawnSync(command, args, { stdio: "ignore" });
}
