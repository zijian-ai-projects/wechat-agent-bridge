import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import { getDaemonLogPath, getDataDir, getPidPath } from "../config/paths.js";

export type DaemonCommand = "start" | "stop" | "status" | "logs" | "restart";

export async function runDaemonCommand(command: string | undefined): Promise<void> {
  switch (command) {
    case "start":
      await startDaemon();
      return;
    case "stop":
      await stopDaemon();
      return;
    case "status":
      printStatus();
      return;
    case "logs":
      printLogs();
      return;
    case "restart":
      await stopDaemon();
      await startDaemon();
      return;
    default:
      console.log("Usage: npm run daemon -- start|stop|status|logs|restart");
  }
}

async function startDaemon(): Promise<void> {
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.log(`Already running (PID ${existing})`);
    return;
  }

  mkdirSync(dirname(getPidPath()), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(getDaemonLogPath()), { recursive: true, mode: 0o700 });
  const logFd = openSync(getDaemonLogPath(), "a");
  const child = spawn(process.execPath, daemonArgs(), {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(getPidPath(), String(child.pid), { encoding: "utf8", mode: 0o600 });
  console.log(`Started (PID ${child.pid}). Logs: ${getDaemonLogPath()}`);
}

async function stopDaemon(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log("Not running");
    return;
  }
  if (!isRunning(pid)) {
    console.log("Not running (stale PID file)");
    writeFileSync(getPidPath(), "", { encoding: "utf8", mode: 0o600 });
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!isRunning(pid)) {
      console.log(`Stopped (PID ${pid})`);
      writeFileSync(getPidPath(), "", { encoding: "utf8", mode: 0o600 });
      return;
    }
  }
  process.kill(pid, "SIGKILL");
  writeFileSync(getPidPath(), "", { encoding: "utf8", mode: 0o600 });
  console.log(`Stopped (PID ${pid}, forced)`);
}

function printStatus(): void {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`Running (PID ${pid})`);
  } else {
    console.log("Not running");
  }
}

function printLogs(): void {
  const files = [getDaemonLogPath(), join(getDataDir(), "logs", `bridge-${new Date().toISOString().slice(0, 10)}.log`)];
  for (const file of files) {
    if (!existsSync(file)) continue;
    console.log(`=== ${file} ===`);
    console.log(tail(file, 120));
  }
}

function daemonArgs(): string[] {
  const distMain = join(process.cwd(), "dist", "main.js");
  if (existsSync(distMain)) return [distMain, "start"];
  return [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "main.ts"), "start"];
}

function readPid(): number | undefined {
  try {
    const raw = readFileSync(getPidPath(), "utf8").trim();
    if (!raw) return undefined;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tail(file: string, lines: number): string {
  try {
    if (!statSync(file).isFile()) return "";
    return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}
