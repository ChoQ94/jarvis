/**
 * 자기 모니터링.
 *
 * 알람 앱이 조용히 고장 나면 '안 울렸다'는 사실조차 모른다.
 * 크론이 밀리거나 발송이 실패하면 텔레그램으로 알린다.
 *
 * 한계: Worker 자체가 아예 안 돌면 이 코드도 안 돌아 알릴 수 없다.
 *       부분 실패와 지연을 잡는 것이 목적이다.
 */
import { sendMessage } from './telegram';

/** 같은 경고를 반복해 보내지 않기 위한 최소 간격 */
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6시간
/**
 * 크론이 이만큼 안 돌았으면 밀린 것으로 본다.
 *
 * 하트비트는 크론이 돌 때마다, 즉 매 분 찍는다. 정상 간격은 1분이다.
 * Cloudflare 크론은 트리거가 몇십 초에서 몇 분까지 밀리거나 아예 건너뛸 수 있으므로
 * 그 정도 요동으로는 경고하지 않도록 10분으로 잡는다.
 *
 * 예전에는 D1 쓰기를 아끼려고 '실행 시각의 분이 5의 배수일 때만' 하트비트를 찍었다.
 * 그런데 그 분은 예정 시각이 아니라 실제 실행 시각에서 읽었다. 트리거가 1분만 밀려도
 * 5의 배수 구간을 통째로 건너뛰어, 크론이 매 분 정상으로 돌고 알람도 다 나갔는데
 * last_tick 은 30분씩 낡아 거짓 경고가 나갔다. 지금은 매 분 찍는다.
 * 하루 1,440건으로 D1 무료 한도(10만 건/일)의 1.5% 수준이다.
 */
export const TICK_GAP_ALERT_MS = 10 * 60 * 1000;

async function get(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM system_state WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function set(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .bind(key, value, value)
    .run();
}

/** 경고를 보낸다. 같은 종류는 쿨다운 안에 다시 보내지 않는다. */
export async function alert(
  db: D1Database,
  token: string,
  chatId: string,
  kind: string,
  text: string,
): Promise<void> {
  const key = `alert:${kind}`;
  const last = Number((await get(db, key)) ?? 0);
  const now = Date.now();
  if (now - last < ALERT_COOLDOWN_MS) return;

  try {
    await sendMessage(token, chatId, `🚨 자비스 이상 감지\n\n${text}`);
    await set(db, key, String(now));
  } catch (err) {
    console.error('경고 발송 실패', err);
  }
}

/**
 * 크론이 정상 주기로 돌고 있는지 확인하고 현재 시각을 기록한다.
 * 이전 실행과의 간격이 비정상이면 경고한다.
 *
 * @returns 이전 실행 시각(ms). 첫 실행이면 null.
 *          호출부는 이 값으로 '놓친 구간'을 계산해 알람을 보정한다.
 */
export async function recordTick(
  db: D1Database,
  token: string,
  chatId: string,
  now: Date,
): Promise<number | null> {
  const prev = Number((await get(db, 'last_tick')) ?? 0);
  await set(db, 'last_tick', String(now.getTime()));

  if (!prev) return null; // 첫 실행
  const gap = now.getTime() - prev;
  if (gap > TICK_GAP_ALERT_MS) {
    const minutes = Math.round(gap / 60_000);
    await alert(
      db,
      token,
      chatId,
      'tick-gap',
      `크론이 ${minutes}분 동안 실행되지 않았어요.\n놓친 알람은 지금 함께 보냈습니다.`,
    );
  }
  return prev;
}
