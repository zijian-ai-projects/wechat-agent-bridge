export type BridgeErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_BOUND"
  | "SESSION_UNAVAILABLE"
  | "AGENT_ERROR"
  | "UNKNOWN_TOOL"
  | "INTERNAL_ERROR";

export class BridgeError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface ToolErrorPayload {
  code: BridgeErrorCode;
  message: string;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T; error?: undefined }
  | { ok: false; error: ToolErrorPayload; data?: undefined };

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail(error: unknown, fallbackCode: BridgeErrorCode = "INTERNAL_ERROR"): ToolResult<never> {
  const normalized = normalizeError(error, fallbackCode);
  return { ok: false, error: normalized };
}

export function normalizeError(error: unknown, fallbackCode: BridgeErrorCode = "INTERNAL_ERROR"): ToolErrorPayload {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message };
  }
  return { code: fallbackCode, message: String(error) };
}
