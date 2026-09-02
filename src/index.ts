import { partsInTz, cronMatches, describeCron } from './cron';
import { interpret } from './nlp';
import { sendMessage, type TelegramUpdate } from './telegram';
import { CHAT_HTML, LOGIN_HTML, authCookie, hashToken, isAuthed } from './web';

export interface Env {
  DB: D1Database;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  DEFAULT_TZ: string;
  /** 선택: 콤마로 구분된 허용 chat_id. 비워두면 누구나 봇 사용 가능 */
  ALLOWED_CHAT_IDS?: string;
  /** 웹 채팅 UI 로그인 비밀번호 */
  WEB_PASSWORD?: string;
}

interface Reminder {
  id: number;
  chat_id: string;
  message: string;
  cron: string;
  timezone: string;
  once_at: string | null;
  last_sent: string | null;
  enabled: number;
}

const HELP = `자비스 알람봇

그냥 말하듯 적으면 알람이 등록됩니다.
  내일 3시에 병원 알려줘
  매일 아침 9시에 약 먹기
  평일 8시 반 스탠드업 회의
  월수금 7시에 헬스장
  주말 10시에 청소하기
  25일 9시에 월세 이체

명령어
  /list        등록된 알람 보기
  /del 3       삭제
  /off 3       잠시 끄기
  /on 3        다시 켜기
  /id          내 chat_id 확인

시간은 09:00, 9시, 오후 3시, 8시 반 모두 인식합니다.
'내일', '9/2' 처럼 날짜를 적으면 한 번만 울리고 꺼집니다.`;

// ─────────────────────────── 명령어 처리 ───────────────────────────

async function handleCommand(text: string, chatId: string, env: Env): Promise<string> {
  const tz = env.DEFAULT_TZ || 'Asia/Seoul';
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd.toLowerCase().replace(/@.*$/, '')) {
    case '/start':
    case '/help':
      return HELP;

    case '/id':
      return `이 대화의 chat_id는 ${chatId} 입니다.`;

    case '/add': {
      const parsed = await interpret(arg, tz, new Date(), env.AI);
      if (!parsed.ok) return `등록 실패: ${parsed.error}`;

      const { results } = await env.DB.prepare(
        `INSERT INTO reminders (chat_id, message, cron, timezone, once_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
        .bind(chatId, parsed.message!, parsed.cron ?? '', tz, parsed.onceAt ?? null)
        .all<{ id: number }>();

      const id = results[0]?.id;
      const when = parsed.onceAt
        ? parsed.onceAt.replace('T', ' ')
        : describeCron(parsed.cron!);
      return `등록했어요 (#${id})\n${when}\n${parsed.message}`;
    }

    case '/list': {
      const { results } = await env.DB.prepare(
        'SELECT * FROM reminders WHERE chat_id = ? ORDER BY id',
      )
        .bind(chatId)
        .all<Reminder>();

      if (results.length === 0) return '등록된 알람이 없어요. /add 로 추가해보세요.';

      return results
        .map((r) => {
          const when = r.once_at ? r.once_at.replace('T', ' ') : describeCron(r.cron);
          const off = r.enabled ? '' : ' (꺼짐)';
          return `#${r.id} ${when}${off}\n   ${r.message}`;
        })
        .join('\n\n');
    }

    case '/del': {
      const id = Number(arg);
      if (!Number.isInteger(id)) return '번호를 알려주세요. 예) /del 3';
      const res = await env.DB.prepare('DELETE FROM reminders WHERE id = ? AND chat_id = ?')
        .bind(id, chatId)
        .run();
      return res.meta.changes ? `#${id} 삭제했어요.` : `#${id} 을(를) 찾지 못했어요.`;
    }

    case '/on':
    case '/off': {
      const id = Number(arg);
      if (!Number.isInteger(id)) return `번호를 알려주세요. 예) ${cmd} 3`;
      const enabled = cmd.toLowerCase().startsWith('/on') ? 1 : 0;
      const res = await env.DB.prepare(
        'UPDATE reminders SET enabled = ? WHERE id = ? AND chat_id = ?',
      )
        .bind(enabled, id, chatId)
        .run();
      if (!res.meta.changes) return `#${id} 을(를) 찾지 못했어요.`;
      return enabled ? `#${id} 다시 켰어요.` : `#${id} 껐어요.`;
    }

    default:
      // '/' 로 시작하지 않으면 명령이 아니라 자연어 요청으로 본다
      if (!cmd.startsWith('/')) return handleCommand(`/add ${text.trim()}`, chatId, env);
      return `모르는 명령이에요.\n\n${HELP}`;
  }
}

// ─────────────────────────── 웹훅 (fetch) ───────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok');
    }

    // ── 웹 채팅 UI ──────────────────────────────────────────────
    const html = (body: string, status = 200) =>
      new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (url.pathname === '/' && request.method === 'GET') {
      if (!env.WEB_PASSWORD) return html('<p>WEB_PASSWORD 시크릿이 설정되지 않았습니다.</p>', 503);
      return (await isAuthed(request, env.WEB_PASSWORD)) ? html(CHAT_HTML) : html(LOGIN_HTML);
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      const form = await request.formData();
      const given = String(form.get('password') ?? '');
      if (!env.WEB_PASSWORD || given !== env.WEB_PASSWORD) {
        return new Response(null, { status: 303, headers: { Location: '/?e=1' } });
      }
      return new Response(null, {
        status: 303,
        headers: { Location: '/', 'Set-Cookie': authCookie(await hashToken(env.WEB_PASSWORD)) },
      });
    }

    // 알람 목록 (웹 UI 렌더링용)
    if (url.pathname === '/api/reminders' && request.method === 'GET') {
      if (!(await isAuthed(request, env.WEB_PASSWORD))) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const owner = env.ALLOWED_CHAT_IDS?.split(',')[0]?.trim() ?? '';
      const { results } = await env.DB.prepare(
        'SELECT * FROM reminders WHERE chat_id = ? ORDER BY enabled DESC, id',
      )
        .bind(owner)
        .all<Reminder>();

      return Response.json(
        results.map((r) => ({
          id: r.id,
          message: r.message,
          enabled: !!r.enabled,
          once: !!r.once_at,
          when: r.once_at ? r.once_at.replace('T', ' ') : describeCron(r.cron),
        })),
      );
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      if (!(await isAuthed(request, env.WEB_PASSWORD))) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const owner = env.ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
      if (!owner) return Response.json({ reply: 'ALLOWED_CHAT_IDS 가 설정되지 않아 알림 대상을 알 수 없어요.' });

      const { text } = (await request.json()) as { text?: string };
      if (!text?.trim()) return Response.json({ reply: '내용이 비어 있어요.' });

      try {
        const reply = await handleCommand(text.trim(), owner, env);
        return Response.json({ reply });
      } catch (err) {
        console.error('web chat failed', err);
        return Response.json({ reply: '처리 중 오류가 났어요.' });
      }
    }

    // ── 텔레그램 웹훅 ────────────────────────────────────────────
    if (url.pathname !== '/webhook' || request.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }

    // 텔레그램이 보낸 요청이 맞는지 확인 (아무나 이 URL을 때리지 못하게)
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message;
    if (!message?.text) return new Response('ok'); // 텍스트가 아닌 업데이트는 무시

    const chatId = String(message.chat.id);

    // 개인용이면 본인 chat_id만 허용
    const allowed = env.ALLOWED_CHAT_IDS?.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed?.length && !allowed.includes(chatId)) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, '이 봇은 개인용이에요.').catch(() => {});
      return new Response('ok');
    }

    let reply: string;
    try {
      reply = await handleCommand(message.text, chatId, env);
    } catch (err) {
      console.error('command failed', err);
      reply = '처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.';
    }

    // 텔레그램은 200이 아니면 같은 update 를 재시도한다.
    // 발송이 실패해도 명령은 이미 처리됐으므로 200 을 돌려 중복 실행을 막는다.
    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
    } catch (err) {
      console.error('reply 발송 실패', err);
    }
    return new Response('ok');
  },

  // ───────────────────────── 크론 (매 분 실행) ─────────────────────────

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchDue(env));
  },
};

async function dispatchDue(env: Env): Promise<void> {
  const now = new Date();

  const { results } = await env.DB.prepare('SELECT * FROM reminders WHERE enabled = 1').all<Reminder>();
  if (results.length === 0) return;

  // 크론 트리거가 몇 초 밀려 분을 건너뛰는 경우에 대비해 직전 1분도 함께 확인.
  // 중복 발송은 last_sent 로 막는다.
  const instants = [now, new Date(now.getTime() - 60_000)];
  const updates: D1PreparedStatement[] = [];

  for (const r of results) {
    const tz = r.timezone || 'Asia/Seoul';
    const nowStamp = partsInTz(now, tz).stamp;

    let dueStamp: string | null = null;

    if (r.once_at) {
      // 일회성: 예정 시각이 지났으면 (놓쳤더라도) 발송
      if (r.once_at <= nowStamp) dueStamp = r.once_at;
    } else {
      for (const instant of instants) {
        const p = partsInTz(instant, tz);
        if (p.stamp !== r.last_sent && cronMatches(r.cron, p)) {
          dueStamp = p.stamp;
          break;
        }
      }
    }

    if (!dueStamp || dueStamp === r.last_sent) continue;

    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, r.chat_id, `⏰ ${r.message}`);
      updates.push(
        r.once_at
          ? env.DB.prepare('UPDATE reminders SET enabled = 0, last_sent = ? WHERE id = ?').bind(dueStamp, r.id)
          : env.DB.prepare('UPDATE reminders SET last_sent = ? WHERE id = ?').bind(dueStamp, r.id),
      );
    } catch (err) {
      // 한 건이 실패해도 나머지는 계속 보낸다
      console.error(`reminder ${r.id} 발송 실패`, err);
    }
  }

  if (updates.length) await env.DB.batch(updates);
}
