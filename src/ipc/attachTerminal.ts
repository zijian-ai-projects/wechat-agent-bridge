import { spawn as defaultSpawn, type SpawnOptions } from "node:child_process";

export interface AttachTerminalLaunch {
  command: string;
  args: string[];
  displayCommand: string;
}

export interface LaunchAttachTerminalOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  project?: string;
  spawn?: SpawnAttachTerminal;
  onError?: (error: Error) => void;
}

export interface AttachTerminalLaunchResult {
  launched: boolean;
  command?: string;
  reason?: string;
}

export type SpawnAttachTerminal = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};

export function isAutoAttachEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WECHAT_AGENT_BRIDGE_AUTO_ATTACH !== "0";
}

export function launchAttachTerminal(options: LaunchAttachTerminalOptions = {}): AttachTerminalLaunchResult {
  const env = options.env ?? process.env;
  if (!isAutoAttachEnabled(env)) {
    return { launched: false, reason: "disabled" };
  }
  const launch = buildAttachTerminalLaunch({
    cwd: options.cwd ?? process.cwd(),
    platform: options.platform ?? process.platform,
    project: options.project,
  });
  if (!launch) {
    return { launched: false, reason: `unsupported platform: ${options.platform ?? process.platform}` };
  }

  try {
    const spawn = options.spawn ?? defaultSpawn;
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd ?? process.cwd(),
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: false,
    });
    child.once("error", (error) => {
      options.onError?.(error);
    });
    child.unref();
    return { launched: true, command: launch.displayCommand };
  } catch (error) {
    return { launched: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function buildAttachTerminalLaunch(options: {
  cwd: string;
  platform: NodeJS.Platform;
  project?: string;
}): AttachTerminalLaunch | undefined {
  const attachCommand = formatNpmAttachCommand(options.project);
  switch (options.platform) {
    case "win32":
      return {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `start "" /D ${quoteCmdArg(options.cwd)} cmd.exe /k ${quoteCmdArg(attachCommand)}`,
        ],
        displayCommand: attachCommand,
      };
    case "darwin": {
      const shellCommand = `cd ${quoteShellArg(options.cwd)} && ${attachCommand}`;
      return {
        command: "osascript",
        args: ["-e", `tell application "Terminal" to do script ${quoteAppleScriptString(shellCommand)}`],
        displayCommand: attachCommand,
      };
    }
    case "linux":
    case "freebsd":
    case "openbsd": {
      const shellCommand = `cd ${quoteShellArg(options.cwd)} && ${attachCommand}; exec \${SHELL:-sh}`;
      return {
        command: "x-terminal-emulator",
        args: ["-e", "sh", "-lc", shellCommand],
        displayCommand: attachCommand,
      };
    }
    default:
      return undefined;
  }
}

function formatNpmAttachCommand(project?: string): string {
  if (!project) return "npm run attach";
  return `npm run attach -- ${quoteShellArg(project)}`;
}

function quoteCmdArg(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
