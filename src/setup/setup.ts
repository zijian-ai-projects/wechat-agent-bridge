import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";

import QRCode from "qrcode";

import { saveAccount } from "../config/accounts.js";
import { loadConfig, saveConfig } from "../config/config.js";
import { getDataDir } from "../config/paths.js";
import { ProjectCatalog, resolveProjectsRootConfig } from "../config/projects.js";
import { checkCodexInstalled } from "../runtime/codexAvailability.js";
import { assertCodexLoggedIn, formatCodexLoginGuidance } from "../config/codexAuth.js";
import { startQrLogin, waitForQrScan } from "../wechat/login.js";
import { runSetupFlow } from "./flow.js";

export async function runSetup(): Promise<void> {
  mkdirSync(getDataDir(), { recursive: true, mode: 0o700 });

  const codex = checkCodexInstalled();
  if (!codex.ok) {
    throw new Error(`未找到本机 codex CLI: ${codex.error}\n请先安装并登录 Codex CLI。`);
  }
  console.log(`已检测到 codex: ${codex.version || "installed"}`);
  const login = assertCodexLoggedIn();
  console.log(formatCodexLoginGuidance(login));

  const rl = createInterface({ input, output });
  try {
    const current = loadConfig();
    const message = await runSetupFlow({
      currentConfig: current,
      bindWechat: async () => {
        const account = await bindWechat();
        saveAccount(account);
        console.log(`微信绑定成功，bound user id: ${account.boundUserId}`);
        return { boundUserId: account.boundUserId };
      },
      ask: (prompt) => rl.question(prompt),
      resolveProjectsRoot: async (projectsRootInput) =>
        (await resolveProjectsRootConfig({ ...current, projectsRoot: projectsRootInput })).projectsRoot,
      discoverProjects: async (projectsRoot) => new ProjectCatalog(projectsRoot).list(),
      saveConfig,
      initGitRepo: async (cwd) => {
        const result = spawnSync("git", ["init", cwd], { encoding: "utf8" });
        if (result.status !== 0) {
          throw new Error(`git init 失败: ${result.stderr.trim() || result.stdout.trim()}`);
        }
      },
    });
    console.log(message);
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
