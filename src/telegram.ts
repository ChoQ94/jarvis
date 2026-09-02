/** 텔레그램 Bot API 최소 래퍼 */

export async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram sendMessage ${res.status}: ${body}`);
  }
}

/** 텔레그램 update 페이로드 중 실제로 쓰는 부분만 */
export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name?: string };
  };
}
