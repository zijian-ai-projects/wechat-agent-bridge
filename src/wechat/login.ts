import { DEFAULT_WECHAT_BASE_URL, type AccountData } from "../config/accounts.js";
import { logger } from "../logging/logger.js";

const QR_CODE_URL = `${DEFAULT_WECHAT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
const QR_STATUS_URL = `${DEFAULT_WECHAT_BASE_URL}/ilink/bot/get_qrcode_status`;

interface QrCodeResponse {
  ret: number;
  qrcode?: string;
  qrcode_img_content?: string;
}

interface QrStatusResponse {
  ret: number;
  status: string;
  retmsg?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export async function startQrLogin(): Promise<{ qrcodeUrl: string; qrcodeId: string }> {
  const response = await fetch(QR_CODE_URL);
  if (!response.ok) throw new Error(`Failed to request QR code: HTTP ${response.status}`);
  const data = (await response.json()) as QrCodeResponse;
  if (data.ret !== 0 || !data.qrcode || !data.qrcode_img_content) {
    throw new Error(`Failed to request QR code: ret=${data.ret}`);
  }
  logger.info("QR login started", { qrcodeId: data.qrcode });
  return { qrcodeUrl: data.qrcode_img_content, qrcodeId: data.qrcode };
}

export async function waitForQrScan(qrcodeId: string): Promise<AccountData> {
  while (true) {
    const response = await fetch(`${QR_STATUS_URL}?qrcode=${encodeURIComponent(qrcodeId)}`);
    if (!response.ok) throw new Error(`Failed to poll QR status: HTTP ${response.status}`);
    const data = (await response.json()) as QrStatusResponse;

    if (data.status === "confirmed") {
      if (!data.bot_token || !data.ilink_bot_id || !data.ilink_user_id) {
        throw new Error("QR confirmed but required account fields are missing");
      }
      return {
        accountId: data.ilink_bot_id,
        botToken: data.bot_token,
        boundUserId: data.ilink_user_id,
        baseUrl: data.baseurl || DEFAULT_WECHAT_BASE_URL,
        createdAt: new Date().toISOString(),
      };
    }

    if (data.status === "expired") throw new Error("QR code expired");
    if (data.status && !["wait", "scaned"].includes(data.status)) {
      throw new Error(data.retmsg || `QR scan failed: ${data.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
