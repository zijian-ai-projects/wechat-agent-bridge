export interface CommandHelpEntry {
  name: string;
  summary: string;
  syntax: string[];
  core: boolean;
  changesProject: boolean;
  interruptsRunningWork: boolean;
  examples: string[];
  notes: string[];
}

export const COMMAND_HELP: CommandHelpEntry[] = [
  {
    name: "help",
    summary: "查看命令总览或某个命令的详细说明",
    syntax: ["/help", "/help <command>"],
    core: false,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/help", "/help project", "/help replace"],
    notes: ["不带参数时显示常用命令总览。", "带命令名时显示该命令的详细说明。"],
  },
  {
    name: "project",
    summary: "查看项目列表，或切换当前项目",
    syntax: ["/project", "/project <name>", "/project <name> --init"],
    core: true,
    changesProject: true,
    interruptsRunningWork: false,
    examples: ["/project", "/project SageTalk", "/project scratch --init"],
    notes: ["项目名来自 projectsRoot 下的一级子目录名。", "非 Git 目录需要显式使用 --init。"],
  },
  {
    name: "status",
    summary: "查看当前项目或指定项目的状态",
    syntax: ["/status", "/status <project>"],
    core: true,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/status", "/status SageTalk"],
    notes: ["不带项目名时显示当前项目和整体概览。"],
  },
  {
    name: "interrupt",
    summary: "中断当前或指定项目的运行中任务",
    syntax: ["/interrupt", "/interrupt <project>"],
    core: true,
    changesProject: false,
    interruptsRunningWork: true,
    examples: ["/interrupt", "/interrupt SageTalk"],
    notes: ["不带项目名时作用于当前项目。"],
  },
  {
    name: "replace",
    summary: "中断当前或指定项目，并立即执行新的 prompt",
    syntax: ["/replace <prompt>", "/replace <project> <prompt>"],
    core: true,
    changesProject: false,
    interruptsRunningWork: true,
    examples: ["/replace 重新跑测试", "/replace SageTalk 重新按这个方案实现"],
    notes: ["不带项目名时作用于当前项目。", "目标项目未初始化时，需先执行 /project <name> --init。"],
  },
  {
    name: "history",
    summary: "查看最近对话历史",
    syntax: ["/history", "/history <n>", "/history <project> <n>"],
    core: true,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/history", "/history 10", "/history SageTalk 5"],
    notes: ["n 必须是正整数。"],
  },
  {
    name: "clear",
    summary: "清除当前或指定项目的会话",
    syntax: ["/clear", "/clear <project>"],
    core: false,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/clear", "/clear SageTalk"],
    notes: ["清除后，下次消息会新开 Codex 会话。"],
  },
  {
    name: "mode",
    summary: "查看或切换运行模式",
    syntax: ["/mode", "/mode <readonly|workspace|yolo>", "/mode <project> <readonly|workspace|yolo>"],
    core: false,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/mode", "/mode workspace", "/mode SageTalk readonly"],
    notes: ["默认是 readonly。yolo 是高风险全权限模式。"],
  },
  {
    name: "model",
    summary: "查看或切换模型",
    syntax: ["/model", "/model <name>", "/model <project> <name>"],
    core: false,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/model", "/model gpt-5.4", "/model SageTalk gpt-5.4"],
    notes: ["不带参数时显示当前配置。"],
  },
  {
    name: "models",
    summary: "查看 Codex 可用模型目录",
    syntax: ["/models"],
    core: false,
    changesProject: false,
    interruptsRunningWork: false,
    examples: ["/models"],
    notes: ["模型目录来自本机 codex debug models；读取失败不会影响 /model <name>。"],
  },
  {
    name: "cwd",
    summary: "按路径查看或切换到已配置项目",
    syntax: ["/cwd", "/cwd <path>"],
    core: false,
    changesProject: true,
    interruptsRunningWork: false,
    examples: ["/cwd", "/cwd /Users/you/.codex/projects/SageTalk"],
    notes: ["这是兼容命令。只支持切换到已配置项目的 cwd，不支持任意 cd。"],
  },
];

export function formatHelpOverview(): string {
  return [
    "常用命令:",
    ...COMMAND_HELP.filter((entry) => entry.core).map((entry) => `/${entry.name.padEnd(10, " ")} ${entry.summary}`),
    "",
    "发送 /help <command> 查看详细说明。",
  ].join("\n");
}

export function formatHelpDetail(name: string): string | undefined {
  const entry = COMMAND_HELP.find((item) => item.name === name);
  if (!entry) return undefined;
  return [
    `命令: /${entry.name}`,
    `作用: ${entry.summary}`,
    `语法: ${entry.syntax.join(" | ")}`,
    `是否会切换当前项目: ${entry.changesProject ? "会" : "不会"}`,
    `是否会中断当前任务: ${entry.interruptsRunningWork ? "会" : "不会"}`,
    `示例: ${entry.examples.join(" | ")}`,
    `注意事项: ${entry.notes.join(" ")}`,
  ].join("\n");
}
