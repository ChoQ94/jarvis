/**
 * 자연어 → 스케줄 해석.
 *
 * 1단계: 규칙 파서(parse.ts). 흔한 표현은 여기서 0ms·무료로 처리된다.
 * 2단계: 규칙이 실패했을 때만 Workers AI 호출. ("다음주 화요일엔 쓰레기 버려야해" 같은 문장)
 */
import { parseSchedule, type ParseResult } from './parse';
import { partsInTz } from './cron';

export interface NlpResult {
  ok: boolean;
  cron?: string;
  onceAt?: string | null;
  message?: string;
  error?: string;
  /** 어느 단계에서 해석했는지 (사용자 안내·디버깅용) */
  via?: 'rule' | 'ai';
}

// 추론(reasoning) 모델은 생각에 토큰을 다 쓰고 지연도 커서 이 용도엔 부적합하다.
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYSTEM = `너는 한국어 리마인더 문장을 구조화된 JSON으로 바꾸는 파서다.
반드시 JSON만 출력한다. 설명, 인사, 코드블록 표시를 붙이지 마라.

출력 스키마:
{"cron":"분 시 일 월 요일" 또는 "", "once_at":"YYYY-MM-DDTHH:mm" 또는 null, "message":"알림 내용"}

규칙:
- 반복되는 일정이면 cron 을 채우고 once_at 은 null 로 둔다.
- 특정 날짜에 한 번만이면 once_at 을 채우고 cron 은 "" 으로 둔다.
- message 에는 '알려줘', '리마인드' 같은 요청 표현을 빼고 할 일만 남긴다.
- 요일은 0=일요일 ... 6=토요일. 평일은 1-5, 주말은 0,6.
- 시각을 특정할 수 없으면 {"error":"시각을 알 수 없음"} 을 출력한다.

예시:
입력: 매일 아침 9시에 약 먹기
출력: {"cron":"0 9 * * *","once_at":null,"message":"약 먹기"}
입력: 평일 8시 반에 스탠드업 회의
출력: {"cron":"30 8 * * 1-5","once_at":null,"message":"스탠드업 회의"}
입력: 다음주 월요일 오후 2시에 치과
출력: {"cron":"","once_at":"2026-09-07T14:00","message":"치과"}`;

/** AI 응답에서 JSON 객체만 뽑아낸다 (앞뒤 잡소리·코드블록 방어) */
function extractJson(text: string): any | null {
  const cleaned = text.replace(/```json?/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
const ONCE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export async function interpret(
  input: string,
  tz: string,
  now: Date,
  ai?: Ai,
): Promise<NlpResult> {
  // 1단계 — 규칙 파서
  const ruled: ParseResult = parseSchedule(input, tz, now);
  if (ruled.ok) {
    return { ok: true, cron: ruled.cron, onceAt: ruled.onceAt, message: ruled.message, via: 'rule' };
  }

  // 2단계 — AI fallback
  if (!ai) return { ok: false, error: ruled.error };

  const p = partsInTz(now, tz);
  const today = p.stamp.slice(0, 10);
  const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const DOW = DOW_KO[p.weekday];

  // 모델이 요일을 계산하다 틀리는 일이 잦아, 앞으로 2주치 날짜표를 직접 제공한다.
  const [ty, tm, td] = today.split('-').map(Number);
  const calendar = Array.from({ length: 15 }, (_, k) => {
    const d = new Date(Date.UTC(ty, tm - 1, td + k));
    const iso = d.toISOString().slice(0, 10);
    const label = k === 0 ? ' (오늘)' : k === 1 ? ' (내일)' : k === 2 ? ' (모레)' : '';
    return `${iso}(${DOW_KO[d.getUTCDay()]})${label}`;
  }).join(', ');

  try {
    const res: any = await ai.run(MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `오늘은 ${today} (${DOW}요일), 현재 시각 ${p.stamp.slice(11)} (${tz}) 이다.\n` +
            `날짜표(이 표의 날짜만 사용할 것): ${calendar}\n` +
            `입력: ${input}`,
        },
      ],
      max_tokens: 300,
      temperature: 0,
    });

    // 모델에 따라 응답 형태가 다르다: OpenAI 호환(choices) 또는 Workers AI 고유(response)
    const rawText = String(res?.choices?.[0]?.message?.content ?? res?.response ?? '');
    const parsed = extractJson(rawText);
    if (!parsed) return { ok: false, error: ruled.error };
    if (parsed.error) return { ok: false, error: '무슨 뜻인지 모르겠어요. 시각을 알려주세요.' };

    const message = String(parsed.message ?? '').trim();
    const cron = String(parsed.cron ?? '').trim();
    const onceAt = parsed.once_at ? String(parsed.once_at).trim() : null;

    // AI 출력은 믿지 말고 형식을 검증한다
    if (!message) return { ok: false, error: '무엇을 알려드릴지 모르겠어요.' };
    if (onceAt) {
      if (!ONCE_RE.test(onceAt)) return { ok: false, error: ruled.error };
      if (onceAt < p.stamp) return { ok: false, error: '이미 지난 시각이에요.' };
      return { ok: true, cron: '', onceAt, message, via: 'ai' };
    }
    if (!CRON_RE.test(cron)) return { ok: false, error: ruled.error };
    return { ok: true, cron, onceAt: null, message, via: 'ai' };
  } catch (err) {
    console.error('AI 해석 실패', err);
    return { ok: false, error: ruled.error };
  }
}
