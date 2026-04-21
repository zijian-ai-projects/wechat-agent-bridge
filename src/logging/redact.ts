const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|set-cookie|auth|bot[_-]?token|token|secret|password|api[_-]?key|access[_-]?key|refresh[_-]?token)/i;

function redactString(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/Authorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: Bearer ***")
    .replace(/Cookie\s*:\s*[^"\n\r]+/gi, "Cookie: ***")
    .replace(/Set-Cookie\s*:\s*[^"\n\r]+/gi, "Set-Cookie: ***")
    .replace(/(bot[_-]?token|token|secret|password|api[_-]?key)=([^&\s;]+)/gi, "$1=***");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SECRET_KEY_PATTERN.test(key) ? "***" : redactValue(nested);
    }
    return redacted;
  }
  return value;
}

export function redactSecrets(value: unknown): string {
  if (typeof value === "string") {
    return redactString(value);
  }
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return "[unserializable]";
  }
}
