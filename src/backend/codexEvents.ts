export interface CodexEvent {
  type?: string;
  thread_id?: string;
  session_id?: string;
  error?: unknown;
  item?: Record<string, unknown>;
  text?: string;
  message?: string;
  summary?: string;
  [key: string]: unknown;
}

export function parseJsonLine(line: string, options: { source?: "stdout" | "stderr" } = {}): CodexEvent | undefined {
  if (options.source === "stderr") return undefined;
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return { type: "error", error: { message: `无法解析 Codex JSONL: ${trimmed.slice(0, 120)}` } };
  }
}

export function extractSessionId(event: CodexEvent): string | undefined {
  return event.session_id ?? event.thread_id ?? stringFrom(event, ["thread", "id"]) ?? stringFrom(event, ["session", "id"]);
}

export function extractText(event: CodexEvent): string | undefined {
  const direct = typeof event.text === "string" ? event.text : undefined;
  if (direct) return direct;
  if (typeof event.message === "string") return event.message;
  const item = event.item;
  if (!item) return undefined;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

function stringFrom(source: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}
