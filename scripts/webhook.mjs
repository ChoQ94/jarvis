// 웹훅 등록/조회/삭제. 사용법: node scripts/webhook.mjs set <worker-url>
import { readVar } from './_env.mjs';

const token = readVar('TELEGRAM_BOT_TOKEN');
const action = process.argv[2] ?? 'info';
const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

if (action === 'set') {
  const base = process.argv[3];
  if (!base) {
    console.error('사용법: npm run webhook:set -- https://jarvis.<계정>.workers.dev');
    process.exit(1);
  }
  const secret = readVar('TELEGRAM_WEBHOOK_SECRET');
  const out = await api('setWebhook', {
    url: `${base.replace(/\/$/, '')}/webhook`,
    secret_token: secret,
    allowed_updates: ['message'],
  });
  console.log(out.ok ? `웹훅 등록 완료 → ${base}/webhook` : `실패: ${out.description}`);
} else if (action === 'delete') {
  const out = await api('deleteWebhook');
  console.log(out.ok ? '웹훅 삭제 완료' : `실패: ${out.description}`);
} else {
  const out = await api('getWebhookInfo');
  console.log(JSON.stringify(out.result, null, 2));
}
