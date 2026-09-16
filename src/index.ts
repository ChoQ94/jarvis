import { partsInTz, cronMatches, describeCron } from './cron';
import { interpret } from './nlp';
import { answerCallback, editMessage, sendMessage, type InlineButton, type TelegramUpdate } from './telegram';
import { CHAT_HTML, LOGIN_HTML, authCookie, hashToken, isAuthed } from './web';
import { checkOpenRouter } from './watchers/openrouter';
import { alert, recordTick, TICK_GAP_ALERT_MS } from './health';

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
  /** OpenRouter 신규 모델을 감시할 제작사 (콤마 구분). 비우면 감시 안 함 */
  WATCH_PROVIDERS?: string;
  /** 모델 알림 전용 봇 토큰. 없으면 리마인더 봇으로 보낸다 */
  WATCHER_BOT_TOKEN?: string;
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
  /check       새 AI 모델 지금 확인
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

    case '/check': {
      // 신규 모델을 지금 즉시 확인 (평소엔 매시 정각 자동 실행)
      const providers = env.WATCH_PROVIDERS?.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!providers?.length) return 'WATCH_PROVIDERS 가 설정되지 않았어요.';
      try {
        const token = env.WATCHER_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
        const r = await checkOpenRouter(env.DB, token, chatId, providers);
        if (r.seeded) return `처음이라 현재 모델 목록만 저장했어요. 다음부터 새 모델이 나오면 알려드릴게요.`;
        if (!r.newIds.length) return `새 모델 없어요. (${r.checked}개 확인함)`;
        return `새 모델 ${r.newIds.length}개를 찾아서 알림을 보냈어요.`;
      } catch (err) {
        console.error('/check 실패', err);
        return '확인 중 오류가 났어요.';
      }
    }

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

// ───────────────────────── 알림 버튼 처리 ─────────────────────────

async function handleCallback(
  update: NonNullable<TelegramUpdate['callback_query']>,
  env: Env,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const data = update.data ?? '';
  const msg = update.message;
  const chatId = String(msg?.chat.id ?? update.from.id);
  const tz = env.DEFAULT_TZ || 'Asia/Seoul';

  // 원본 알림에서 내용을 꺼낸다 ("⏰ 약 먹기" → "약 먹기").
  // 덕분에 콜백 데이터(64바이트 제한)에 메시지를 담지 않아도 된다.
  const body = (msg?.text ?? '').replace(/^⏰\s*/, '').split('\n')[0].trim();

  if (data === 'done') {
    await answerCallback(token, update.id, '완료!');
    if (msg) await editMessage(token, chatId, msg.message_id, `✅ ${body}`);
    return;
  }

  if (data.startsWith('snooze:')) {
    const minutes = Number(data.split(':')[1]);
    if (!Number.isFinite(minutes) || !body) {
      await answerCallback(token, update.id, '다시 알릴 내용을 못 찾았어요');
      return;
    }
    const at = partsInTz(new Date(Date.now() + minutes * 60_000), tz).stamp;
    await env.DB.prepare(
      `INSERT INTO reminders (chat_id, message, cron, timezone, once_at) VALUES (?, ?, '', ?, ?)`,
    )
      .bind(chatId, body, tz, at)
      .run();

    const label = minutes >= 60 ? `${minutes / 60}시간` : `${minutes}분`;
    await answerCallback(token, update.id, `${label} 뒤에 다시 알릴게요`);
    if (msg) await editMessage(token, chatId, msg.message_id, `😴 ${body}\n   → ${at.slice(11)} 에 다시`);
    return;
  }

  if (data.startsWith('off:')) {
    const id = Number(data.split(':')[1]);
    await env.DB.prepare('UPDATE reminders SET enabled = 0 WHERE id = ? AND chat_id = ?')
      .bind(id, chatId)
      .run();
    await answerCallback(token, update.id, '이 알람을 껐어요');
    if (msg) await editMessage(token, chatId, msg.message_id, `🔕 ${body}\n   (알람을 껐어요. /on ${id} 로 다시 켤 수 있어요)`);
    return;
  }

  await answerCallback(token, update.id);
}

// ─────────────────────────── 웹훅 (fetch) ───────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok');
    }

    // ── 웹 채팅 UI ──────────────────────────────────────────────
    // no-store: 배포가 잦아 브라우저가 예전 화면을 붙들고 있으면
    // 서버 API 와 형태가 어긋나 아무 반응이 없는 것처럼 보인다.
    const html = (body: string, status = 200) =>
      new Response(body, {
        status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, must-revalidate',
        },
      });

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

    // 시스템 상태 (웹 UI 표시등용)
    if (url.pathname === '/api/status' && request.method === 'GET') {
      if (!(await isAuthed(request, env.WEB_PASSWORD))) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const tz = env.DEFAULT_TZ || 'Asia/Seoul';
      const owner = env.ALLOWED_CHAT_IDS?.split(',')[0]?.trim() ?? '';

      const tickRow = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'last_tick'")
        .first<{ value: string }>();
      const counts = await env.DB.prepare(
        'SELECT (SELECT COUNT(*) FROM reminders WHERE chat_id = ? AND enabled = 1) a, (SELECT COUNT(*) FROM seen_models) m',
      )
        .bind(owner)
        .first<{ a: number; m: number }>();

      const lastTick = Number(tickRow?.value ?? 0);
      // 하트비트는 매 분 찍힌다. 경고와 같은 임계값을 써서 표시등과 알림이 엇갈리지 않게 한다.
      const ageMin = lastTick ? Math.floor((Date.now() - lastTick) / 60_000) : null;

      return Response.json({
        healthy: ageMin !== null && ageMin * 60_000 < TICK_GAP_ALERT_MS,
        ageMin,
        lastTick: lastTick ? partsInTz(new Date(lastTick), tz).stamp.replace('T', ' ') : null,
        now: partsInTz(new Date(), tz).stamp.replace('T', ' '),
        reminders: counts?.a ?? 0,
        watched: counts?.m ?? 0,
        watchProviders: env.WATCH_PROVIDERS?.split(',').map((x) => x.trim()).filter(Boolean) ?? [],
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

    // 알림에 달린 버튼을 눌렀을 때
    if (update.callback_query) {
      const from = String(update.callback_query.from.id);
      const allowedIds = env.ALLOWED_CHAT_IDS?.split(',').map((x) => x.trim()).filter(Boolean);
      if (allowedIds?.length && !allowedIds.includes(from)) return new Response('ok');
      try {
        await handleCallback(update.callback_query, env);
      } catch (err) {
        console.error('callback 처리 실패', err);
      }
      return new Response('ok');
    }

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

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // waitUntil 로 띄우면 핸들러가 먼저 끝나면서 작업이 잘릴 수 있어 직접 await 한다.
    // 크론은 실행 시간이 넉넉하고 여기서 하는 일은 모두 짧다.
    const now = new Date();

    // 먼저 tick 을 기록한다. 뒤 작업이 실패해도 심장박동은 남아야 한다.
    // 크론이 도는 매 분마다 기록한다. 특정 분에만 기록하면 트리거 지연으로 그 분을
    // 건너뛰어 거짓 경고가 난다 (health.ts 의 TICK_GAP_ALERT_MS 주석 참고).
    let prevTick: number | null = null;
    try {
      prevTick = await heartbeat(env, now);
    } catch (err) {
      console.error('heartbeat 실패', err);
    }

    try {
      await dispatchDue(env, now, prevTick);
    } catch (err) {
      console.error('dispatchDue 실패', err);
    }

    // 신규 모델 감시는 매시 정각에만 (크론 자체는 알람 때문에 매 분 돈다)
    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
      await runWatchers(env).catch((err) => console.error('watcher 실패', err));
    }
  },
};

/** 놓친 구간을 되짚어볼 최대 범위. 이보다 오래된 알람은 지금 울려봐야 의미가 없다. */
const MAX_CATCHUP_MINUTES = 120;

async function dispatchDue(env: Env, now: Date, prevTick: number | null): Promise<void> {
  const { results } = await env.DB.prepare('SELECT * FROM reminders WHERE enabled = 1').all<Reminder>();
  if (results.length === 0) return;

  // 기본은 현재 분과 직전 1분(트리거가 몇 초 밀려 분을 건너뛰는 경우 대비).
  // 크론이 오래 멈춰 있었다면 그 구간까지 되짚어 반복 알람을 보정한다.
  // 여러 시각이 맞아도 최신 것 하나만 보낸다 (중복 발송은 last_sent 가 막는다).
  let lookback = 1;
  if (prevTick) {
    const gapMinutes = Math.floor((now.getTime() - prevTick) / 60_000);
    lookback = Math.min(Math.max(gapMinutes, 1), MAX_CATCHUP_MINUTES);
  }
  const instants = Array.from({ length: lookback + 1 }, (_, k) => new Date(now.getTime() - k * 60_000));
  const updates: D1PreparedStatement[] = [];
  const failures: string[] = [];

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
      // 반복 알람만 '끄기' 를 붙인다 (일회성은 발송과 동시에 사라지므로 끌 대상이 없다)
      const buttons: InlineButton[][] = [
        [
          { text: '✅ 완료', callback_data: 'done' },
          { text: '😴 10분', callback_data: 'snooze:10' },
          { text: '😴 1시간', callback_data: 'snooze:60' },
        ],
      ];
      if (!r.once_at) buttons.push([{ text: '🔕 이 알람 끄기', callback_data: `off:${r.id}` }]);

      await sendMessage(env.TELEGRAM_BOT_TOKEN, r.chat_id, `⏰ ${r.message}`, buttons);
      updates.push(
        r.once_at
          // 일회성은 보내고 나면 역할이 끝났으므로 지운다 (목록에 쌓이지 않게)
          ? env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id)
          : env.DB.prepare('UPDATE reminders SET last_sent = ? WHERE id = ?').bind(dueStamp, r.id),
      );
    } catch (err) {
      // 한 건이 실패해도 나머지는 계속 보낸다
      console.error(`reminder ${r.id} 발송 실패`, err);
      failures.push(r.message);
    }
  }

  if (updates.length) await env.DB.batch(updates);

  // 발송이 실패했다면 조용히 넘기지 않고 알린다
  if (failures.length) {
    const owner = env.ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
    if (owner) {
      await alert(
        env.DB,
        env.TELEGRAM_BOT_TOKEN,
        owner,
        'send-failed',
        `알람 ${failures.length}건을 보내지 못했어요.\n\n${failures.map((m) => `• ${m}`).join('\n')}`,
      );
    }
  }
}

/** 크론이 정상 주기로 도는지 기록·확인. 이전 실행 시각(ms)을 돌려준다. */
async function heartbeat(env: Env, now: Date): Promise<number | null> {
  const owner = env.ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
  if (!owner) return null;
  return recordTick(env.DB, env.TELEGRAM_BOT_TOKEN, owner, now);
}

async function runWatchers(env: Env): Promise<void> {
  const providers = env.WATCH_PROVIDERS?.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const chatId = env.ALLOWED_CHAT_IDS?.split(',')[0]?.trim();
  if (!providers?.length || !chatId) return;

  try {
    // 모델 알림은 별도 봇으로 (설정 없으면 리마인더 봇으로 폴백)
    const token = env.WATCHER_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
    const r = await checkOpenRouter(env.DB, token, chatId, providers);
    if (r.newIds.length) console.log(`openrouter: 신규 ${r.newIds.length}건`, r.newIds.join(', '));
  } catch (err) {
    // 감시 실패가 알람 발송을 방해하면 안 된다
    console.error('openrouter 감시 실패', err);
    await alert(
      env.DB,
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      'watcher-failed',
      `OpenRouter 확인에 실패했어요.\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
