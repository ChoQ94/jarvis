/** 텔레그램 Bot API 최소 래퍼 */

export interface InlineButton {
  text: string;
  callback_data: string; // 64바이트 제한
}

async function call(token: string, method: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`telegram ${method} ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  buttons?: InlineButton[][],
): Promise<void> {
  await call(token, 'sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

/** 버튼을 누른 뒤 로딩 표시를 없앤다. 짧은 토스트를 띄울 수도 있다. */
export async function answerCallback(token: string, callbackId: string, text?: string): Promise<void> {
  await call(token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch((err) => console.error('answerCallback 실패', err));
}

/** 이미 보낸 메시지의 본문과 버튼을 바꾼다 (버튼을 지우려면 buttons 생략) */
export async function editMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  buttons?: InlineButton[][],
): Promise<void> {
  await call(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons ?? [] },
  }).catch((err) => console.error('editMessage 실패', err));
}

/** 텔레그램 update 페이로드 중 실제로 쓰는 부분만 */
export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
  };
}
