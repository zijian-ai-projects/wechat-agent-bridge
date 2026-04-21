export const DEFAULT_WECHAT_CHUNK_SIZE = 1800;

export function splitWechatMessage(text: string, maxLength = DEFAULT_WECHAT_CHUNK_SIZE): string[] {
  if (maxLength <= 0) throw new Error("maxLength must be positive");
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength * 0.3)) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
