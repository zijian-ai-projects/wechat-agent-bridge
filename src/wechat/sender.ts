import { splitWechatMessage } from "../runtime/chunking.js";
import { MessageItemType, MessageState, MessageType } from "./types.js";
import type { WeChatApi } from "./api.js";

export interface WeChatSender {
  sendText(toUserId: string, contextToken: string, text: string): Promise<void>;
}

export function createWechatSender(api: WeChatApi, botUserId: string): WeChatSender {
  return {
    async sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
      for (const chunk of splitWechatMessage(text)) {
        await api.sendMessage({
          msg: {
            from_user_id: botUserId,
            to_user_id: toUserId,
            client_id: api.newClientId(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: contextToken,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
          },
        });
      }
    },
  };
}
