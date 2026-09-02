/**
 * 크론 매칭 + 타임존 처리. 외부 의존성 없음.
 * Worker는 항상 UTC로 돌기 때문에, 사용자의 타임존 기준 '벽시계 시각'으로 변환해서 비교한다.
 */

export interface TimeParts {
  minute: number;
  hour: number;
  day: number;
  month: number;   // 1-12
  weekday: number; // 0(일) - 6(토)
  stamp: string;   // 'YYYY-MM-DDTHH:mm' — 중복 발송 방지 키로 사용
}

const WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** UTC 시각을 특정 타임존의 벽시계 시각으로 변환 */
export function partsInTz(date: Date, tz: string): TimeParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23', // 자정을 24시가 아닌 0시로 (h12/hour12 조합의 고전 버그 회피)
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });

  const get = (parts: Intl.DateTimeFormatPart[], type: string) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const parts = fmt.formatToParts(date);
  const year = get(parts, 'year');
  const month = get(parts, 'month');
  const day = get(parts, 'day');
  const hour = get(parts, 'hour');
  const minute = get(parts, 'minute');

  return {
    minute: Number(minute),
    hour: Number(hour),
    day: Number(day),
    month: Number(month),
    weekday: WEEKDAY[get(parts, 'weekday')] ?? 0,
    stamp: `${year}-${month}-${day}T${hour}:${minute}`,
  };
}

/** 크론 필드 하나를 매칭. '*', '5', '1,3,5', '1-5', '*\/10', '0-30/5' 지원 */
function matchField(expr: string, value: number, min: number, max: number): boolean {
  return expr.split(',').some((term) => {
    const [rangePart, stepPart] = term.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step < 1) return false;

    let lo: number;
    let hi: number;

    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = Number(rangePart);
    }

    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

/** '분 시 일 월 요일' 5필드 크론식이 주어진 시각과 맞는지 */
export function cronMatches(expr: string, p: TimeParts): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;

  // 요일은 7도 일요일로 통용되므로 0으로 정규화
  const weekdayExpr = f[4].replace(/7/g, '0');

  return (
    matchField(f[0], p.minute, 0, 59) &&
    matchField(f[1], p.hour, 0, 23) &&
    matchField(f[2], p.day, 1, 31) &&
    matchField(f[3], p.month, 1, 12) &&
    matchField(weekdayExpr, p.weekday, 0, 6)
  );
}

/** 크론식을 사람이 읽을 수 있는 한국어로 (목록 출력용) */
const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f;

  const time =
    /^\d+$/.test(hour) && /^\d+$/.test(min)
      ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
      : `${hour}시 ${min}분`;

  if (dow === '*' && dom === '*' && mon === '*') return `매일 ${time}`;
  if (dom === '*' && mon === '*') {
    if (dow === '1-5') return `평일 ${time}`;
    if (dow === '0,6' || dow === '6,0') return `주말 ${time}`;
    const days = dow
      .replace(/7/g, '0')
      .split(',')
      .flatMap((part) => {
        if (part.includes('-')) {
          const [a, b] = part.split('-').map(Number);
          return Array.from({ length: b - a + 1 }, (_, i) => a + i);
        }
        return [Number(part)];
      })
      .map((d) => DAY_KO[d] ?? '?')
      .join('');
    return `매주 ${days} ${time}`;
  }
  if (mon === '*' && /^\d+$/.test(dom)) return `매월 ${dom}일 ${time}`;
  return expr;
}
