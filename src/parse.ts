/**
 * 한국어 자연어 → 크론식 파싱.
 * "평일 09:00 스탠드업" → { cron: '0 9 * * 1-5', message: '스탠드업' }
 */
import { partsInTz } from './cron';

export type ParseResult =
  | { ok: true; cron: string; onceAt: string | null; message: string }
  | { ok: false; error: string };

const DAY_CHAR: Record<string, number> = {
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
};

/** UTC 기준 순수 날짜 연산 (DST 영향 없음) */
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 이번주(offset 0) / 다음주(offset 1)의 특정 요일 날짜를 구한다. 주의 시작은 월요일. */
function weekdayDate(today: string, todayWeekday: number, weekday: number, offset: number): string {
  const fromMonday = (todayWeekday + 6) % 7; // 일=0 → 6, 월=1 → 0
  const monday = addDays(today, -fromMonday);
  return addDays(monday, offset * 7 + ((weekday + 6) % 7));
}

/** '09:00', '9:00', '9시', '9시30분' → {hour, minute} */
function parseTime(token: string, meridiem: 'am' | 'pm' | null): { hour: number; minute: number } | null {
  let m = token.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    // '9시', '9시30분', '9시반' (반 = 30분)
    const k = token.match(/^(\d{1,2})시(?:\s*(\d{1,2})분?|\s*(반))?$/);
    if (k) m = [k[0], k[1], k[3] ? '30' : (k[2] ?? '0')] as unknown as RegExpMatchArray;
  }
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  // '3시' 처럼 오전/오후를 안 밝힌 1~6시는 오후로 본다 (새벽 알람보다 훨씬 흔하다).
  // 다만 '03:00' 같은 24시간 표기는 사용자가 명시한 것이므로 그대로 둔다.
  const explicit24 = /^\d{1,2}:\d{2}$/.test(token);
  if (meridiem === null && !explicit24 && hour >= 1 && hour <= 6) hour += 12;

  return { hour, minute };
}

/** '알려줘~', '해줘' 같은 요청 꼬리말을 떼어낸다. 메시지 본문은 건드리지 않는다. */
function stripRequestTail(input: string): string {
  return input
    .replace(/[~\u3163]+\s*$/, '')
    .replace(
      /\s*(?:좀\s*)?(?:반복\s*)?(?:알림|리마인드|알람)?\s*(?:알려|리마인드|깨워|말해|보내|해)?\s*(?:줘|주세요|줘요|줄래|주라|주십시오)\s*[.!~]*\s*$/,
      '',
    )
    .trim();
}

/** 스케줄 토큰에 붙은 조사를 떼어낸다. '3\uc2dc\uc5d0' → '3\uc2dc' */
function stripParticle(token: string): string {
  return token.replace(/(?:\uc5d0\ub294|\uc5d0\uc11c|\uc5d0|\uc740|\ub294|\uc5d4|\ucbe4|\uacbd)$/, '') || token;
}

export function parseSchedule(input: string, tz: string, now: Date): ParseResult {
  const raw = stripRequestTail(input.trim());
  if (!raw) return { ok: false, error: '내용이 비어 있어요.' };

  // 이스케이프 해치: 크론식을 직접 쓰고 싶을 때 → "cron 0 9 * * 1 주간회의"
  const cronDirect = raw.match(/^cron\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/i);
  if (cronDirect) {
    return { ok: true, cron: cronDirect[1], onceAt: null, message: cronDirect[2].trim() };
  }

  const tokens = raw.split(/\s+/);
  const today = partsInTz(now, tz).stamp.slice(0, 10);

  let dow = '*';
  let dom = '*';
  let mon = '*';
  let onceDate: string | null = null;
  let weekOffset: number | null = null; // '이번주'=0, '다음주'=1
  let namedWeekday: number | null = null;
  let meridiem: 'am' | 'pm' | null = null;
  let time: { hour: number; minute: number } | null = null;
  let i = 0;

  for (; i < tokens.length; i++) {
    // 시간을 찾았으면 나머지는 전부 메시지
    if (time) break;

    const t = stripParticle(tokens[i]);

    if (t === '오전' || t === '아침' || t === '새벽') { meridiem = 'am'; continue; }
    if (t === '오후' || t === '저녁' || t === '밤' || t === '낮') { meridiem = 'pm'; continue; }

    if (t === '매일' || t === '날마다') { dow = '*'; continue; }
    if (t === '평일') { dow = '1-5'; continue; }
    if (t === '주말') { dow = '0,6'; continue; }
    if (t === '매주' || t === '매월' || t === '에') continue; // 수식어는 흘려보냄

    if (t === '이번주' || t === '금주') { weekOffset = 0; continue; }
    if (t === '다음주' || t === '담주' || t === '차주') { weekOffset = 1; continue; }

    // '월요일', '금요일' 같은 단독 요일
    const wdMatch = t.match(/^([일월화수목금토])요일$/);
    if (wdMatch) { namedWeekday = DAY_CHAR[wdMatch[1]]; continue; }

    if (t === '오늘') { onceDate = today; continue; }
    if (t === '내일') { onceDate = addDays(today, 1); continue; }
    if (t === '모레') { onceDate = addDays(today, 2); continue; }

    // '월수금', '화목' 같은 요일 나열 (요일 글자로만 구성될 때)
    if (/^[일월화수목금토]+$/.test(t) && t !== '일') {
      const days = [...new Set([...t].map((c) => DAY_CHAR[c]))].sort((a, b) => a - b);
      dow = days.join(',');
      continue;
    }

    // '25일' → 매월 25일 / '12/25' → 일회성 날짜
    const domMatch = t.match(/^(\d{1,2})일$/);
    if (domMatch) { dom = domMatch[1]; continue; }

    const dateMatch = t.match(/^(\d{1,2})[/월](\d{1,2})일?$/);
    if (dateMatch) {
      const mm = dateMatch[1].padStart(2, '0');
      const dd = dateMatch[2].padStart(2, '0');
      const year = today.slice(0, 4);
      let candidate = `${year}-${mm}-${dd}`;
      // 이미 지난 날짜면 내년으로
      if (candidate < today) candidate = `${Number(year) + 1}-${mm}-${dd}`;
      onceDate = candidate;
      continue;
    }

    const parsed = parseTime(t, meridiem);
    if (parsed) {
      time = parsed;
      // '9시 30분', '9시 반' 처럼 분이 다음 토큰으로 떨어진 경우 흡수.
      // '09:00' 형태 뒤에는 붙이지 않는다 (메시지 첫 단어를 잘못 먹을 수 있음).
      const next = tokens[i + 1];
      if (/\uc2dc$/.test(t) && next) {
        if (next === '\ubc18') { time.minute = 30; i++; }
        else {
          const mm = next.match(/^(\d{1,2})\ubd84$/);
          if (mm && Number(mm[1]) <= 59) { time.minute = Number(mm[1]); i++; }
        }
      }
      continue;
    }

    break; // 스케줄로 해석 불가 → 여기부터 메시지
  }

  const message = tokens.slice(i).join(' ').trim();

  if (!time) {
    return { ok: false, error: '시각을 못 찾았어요. 예) 평일 09:00 스탠드업' };
  }
  if (!message) {
    return { ok: false, error: '보낼 내용이 없어요. 예) 09:00 물 마시기' };
  }

  const hh = String(time.hour).padStart(2, '0');
  const mm = String(time.minute).padStart(2, '0');

  // '이번주 금요일' / '다음주 월요일' → 일회성 날짜로 확정.
  // LLM 은 요일 계산을 자주 틀리므로 여기서 결정론적으로 계산한다.
  if (namedWeekday !== null && (weekOffset !== null || onceDate === null)) {
    const nowParts = partsInTz(now, tz);
    let target = weekdayDate(today, nowParts.weekday, namedWeekday, weekOffset ?? 0);
    // 이미 지난 시각이면 다음 주로 (단 '다음주'라고 명시했으면 그대로)
    if (weekOffset === null || weekOffset === 0) {
      if (`${target}T${hh}:${mm}` <= nowParts.stamp) target = addDays(target, 7);
    }
    onceDate = target;
  }

  if (onceDate) {
    return { ok: true, cron: '', onceAt: `${onceDate}T${hh}:${mm}`, message };
  }

  return { ok: true, cron: `${time.minute} ${time.hour} ${dom} ${mon} ${dow}`, onceAt: null, message };
}
