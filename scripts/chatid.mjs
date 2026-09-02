// 봇에게 아무 메시지나 보낸 뒤 실행하면 chat_id 를 알려준다.
import { readVar } from './_env.mjs';

const token = readVar('TELEGRAM_BOT_TOKEN');
const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await res.json();

if (!data.ok) {
  console.error('텔레그램 API 오류:', data.description);
  process.exit(1);
}

const chats = new Map();
for (const u of data.result) {
  const chat = u.message?.chat ?? u.edited_message?.chat;
  if (chat) chats.set(chat.id, chat.first_name || chat.title || '(이름없음)');
}

if (chats.size === 0) {
  console.log('아직 받은 메시지가 없어요.');
  console.log('텔레그램에서 봇을 찾아 아무 메시지나 보낸 뒤 다시 실행해주세요.');
  console.log('(웹훅이 이미 켜져 있으면 getUpdates 가 비어 나옵니다 → npm run webhook:delete 후 시도)');
  process.exit(0);
}

console.log('찾은 chat_id:');
for (const [id, name] of chats) console.log(`  ${id}  (${name})`);
