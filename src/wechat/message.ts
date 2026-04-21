import { MessageItemType, type MessageItem, type WeixinMessage } from "./types.js";

export function extractMessageText(message: WeixinMessage): string {
  return (message.item_list ?? [])
    .map((item) => textFromItem(item))
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n")
    .trim();
}

function textFromItem(item: MessageItem): string | undefined {
  if (item.type === MessageItemType.TEXT) return item.text_item?.text;
  if (item.type === MessageItemType.VOICE) return item.voice_item?.voice_text;
  return undefined;
}
