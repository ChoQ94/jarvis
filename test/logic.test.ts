import { partsInTz, cronMatches, describeCron } from '../src/cron';
import { parseSchedule } from '../src/parse';

const TZ = 'Asia/Seoul';
let pass = 0, fail = 0;
const ok = (cond: boolean, label: string, extra = ''): void => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${extra}`); }
};

// 기준 시각: 2026-09-01 화요일 09:00 KST = 2026-09-01T00:00:00Z
const now = new Date('2026-09-01T00:00:00Z');

console.log('\n[1] 타임존 변환 (UTC → KST)');
const p = partsInTz(now, TZ);
ok(p.stamp === '2026-09-01T09:00', 'UTC 00:00 → KST 09:00', p.stamp);
ok(p.weekday === 2, '요일 = 화(2)', String(p.weekday));

console.log('\n[2] 자정 처리 (h23 버그 회피)');
const mid = partsInTz(new Date('2026-09-01T15:00:00Z'), TZ); // KST 다음날 00:00
ok(mid.hour === 0, '자정이 0시로 (24시 아님)', String(mid.hour));
ok(mid.stamp === '2026-09-02T00:00', '날짜도 넘어감', mid.stamp);

console.log('\n[3] 크론 매칭');
ok(cronMatches('0 9 * * *', p), '매일 09:00 → 매치');
ok(!cronMatches('0 10 * * *', p), '매일 10:00 → 매치 안 함');
ok(cronMatches('0 9 * * 1-5', p), '평일 09:00 → 화요일이므로 매치');
ok(!cronMatches('0 9 * * 0,6', p), '주말 09:00 → 매치 안 함');
ok(cronMatches('0 9 * * 2', p), '매주 화 09:00 → 매치');
ok(cronMatches('0 9 1 * *', p), '매월 1일 09:00 → 매치');
ok(cronMatches('*/15 * * * *', p), '15분마다 → 0분이므로 매치');
ok(!cronMatches('0 9 * * 7', p), '일요일(7 표기) → 매치 안 함');
ok(cronMatches('0 9 * * 7', partsInTz(new Date('2026-09-06T00:00:00Z'), TZ)), '일요일(7 표기) → 실제 일요일에 매치');

console.log('\n[4] 한국어 파싱');
const cases: [string, string, string][] = [
  ['09:00 물 마시기',            '0 9 * * *',    '물 마시기'],
  ['매일 9시 스트레칭',           '0 9 * * *',    '스트레칭'],
  ['평일 08:30 스탠드업 회의',    '30 8 * * 1-5', '스탠드업 회의'],
  ['주말 10:00 청소하기',         '0 10 * * 0,6', '청소하기'],
  ['월수금 07:00 헬스장',         '0 7 * * 1,3,5','헬스장'],
  ['오후 3시 약 먹기',            '0 15 * * *',   '약 먹기'],
  ['오전 9시 30분 회의',          '30 9 * * *',   '회의'],
  ['25일 09:00 월세 이체',        '0 9 25 * *',   '월세 이체'],
  ['cron 0 9 * * 1 주간 회의',    '0 9 * * 1',    '주간 회의'],
  ['9시 반 산책',                 '30 9 * * *',   '산책'],
  ['오후 6시 30분 퇴근 스트레칭',  '30 18 * * *',  '퇴근 스트레칭'],
];
for (const [input, expectedCron, expectedMsg] of cases) {
  const r = parseSchedule(input, TZ, now);
  ok(r.ok && r.cron === expectedCron && r.message === expectedMsg,
     `"${input}"`, r.ok ? `→ got "${r.cron}" / "${r.message}"` : `→ ${r.error}`);
}

console.log('\n[5] 일회성 알람');
const t1 = parseSchedule('내일 15:00 병원 예약', TZ, now);
ok(t1.ok && t1.onceAt === '2026-09-02T15:00' && t1.message === '병원 예약',
   '"내일 15:00 병원 예약"', t1.ok ? `→ ${t1.onceAt}` : t1.error);
const t2 = parseSchedule('12/25 09:00 크리스마스', TZ, now);
ok(t2.ok && t2.onceAt === '2026-12-25T09:00', '"12/25 09:00" → 올해 날짜', t2.ok ? `→ ${t2.onceAt}` : t2.error);
const t3 = parseSchedule('1/1 09:00 새해', TZ, now);
ok(t3.ok && t3.onceAt === '2027-01-01T09:00', '"1/1" → 이미 지났으므로 내년', t3.ok ? `→ ${t3.onceAt}` : t3.error);

console.log('\n[5-1] 자연어 (조사·꼬리말)');
const nl: [string, string, string][] = [
  ['내일 3시에 병원 알려줘~',        '', '병원'],
  ['매일 아침 9시에 약 먹기 알려줘',  '0 9 * * *', '약 먹기'],
  ['평일 8시반에 스탠드업',          '30 8 * * 1-5', '스탠드업'],
  ['저녁 7시에 운동하기 좀 알려줘',   '0 19 * * *', '운동하기'],
  ['주말 10시에 청소 리마인드 해줘',  '0 10 * * 0,6', '청소'],
];
for (const [input, expectedCron, expectedMsg] of nl) {
  const r = parseSchedule(input, TZ, now);
  const cronOk = expectedCron === '' ? true : (r.ok && r.cron === expectedCron);
  ok(r.ok && cronOk && r.message === expectedMsg,
     `"${input}"`, r.ok ? `→ cron="${r.cron}" once=${r.onceAt} msg="${r.message}"` : `→ ${r.error}`);
}

console.log('\n[5-1b] 반복 여부');
const rep: [string, boolean, string][] = [
  ['오후 3시에 병원',            false, '병원'],   // 날짜 없음 → 매일 반복
  ['오후 3시에 병원 반복알림해줘', false, '병원'],   // '반복' 은 꼬리말로 제거
  ['내일 오후 3시에 병원',       true,  '병원'],   // 날짜 있음 → 1회
];
for (const [input, expectOnce, expectMsg] of rep) {
  const r = parseSchedule(input, TZ, now);
  ok(r.ok && !!r.onceAt === expectOnce && r.message === expectMsg,
     `"${input}" → ${expectOnce ? '1회' : '반복'}`,
     r.ok ? `once=${r.onceAt} cron="${r.cron}" msg="${r.message}"` : r.error);
}

console.log('\n[5-2] 주/요일 계산 (기준: 2026-09-01 화)');
// 2026-09-01(화) 기준 → 이번주월=08-31, 이번주금=09-04, 다음주월=09-07, 다음주금=09-11
const wk: [string, string][] = [
  ['다음주 월요일 오후 2시에 치과',  '2026-09-07T14:00'],
  ['이번주 금요일 저녁 7시에 회식',  '2026-09-04T19:00'],
  ['다음주 금요일 3시에 미팅',      '2026-09-11T15:00'],
  ['목요일 10시에 정기점검',        '2026-09-03T10:00'],
];
for (const [input, expected] of wk) {
  const r = parseSchedule(input, TZ, now);
  ok(r.ok && r.onceAt === expected, `"${input}" → ${expected}`,
     r.ok ? `got ${r.onceAt}` : r.error);
}

console.log('\n[5-3] 오전/오후 추론');
const mer: [string, string][] = [
  ['내일 3시에 병원',      '2026-09-02T15:00'],  // 오후로 추론
  ['내일 03:00 새벽운동',   '2026-09-02T03:00'],  // 24시간 표기는 그대로
  ['내일 새벽 3시에 기상',  '2026-09-02T03:00'],  // 명시하면 존중
  ['내일 9시에 회의',      '2026-09-02T09:00'],  // 7~12시는 오전
];
for (const [input, expected] of mer) {
  const r = parseSchedule(input, TZ, now);
  ok(r.ok && r.onceAt === expected, `"${input}" → ${expected.slice(11)}`,
     r.ok ? `got ${r.onceAt}` : r.error);
}

console.log('\n[6] 잘못된 입력');
const e1 = parseSchedule('물 마시기', TZ, now);
ok(!e1.ok, '시간 없음 → 에러', e1.ok ? '통과되어버림' : `→ ${e1.error}`);
const e2 = parseSchedule('09:00', TZ, now);
ok(!e2.ok, '내용 없음 → 에러', e2.ok ? '통과되어버림' : `→ ${e2.error}`);
const e3 = parseSchedule('99:99 이상한시간', TZ, now);
ok(!e3.ok, '99:99 → 에러', e3.ok ? '통과되어버림' : `→ ${e3.error}`);

console.log('\n[7] 사람이 읽는 설명');
for (const [c, want] of [['0 9 * * *','매일 09:00'],['30 8 * * 1-5','평일 08:30'],
                          ['0 10 * * 0,6','주말 10:00'],['0 7 * * 1,3,5','매주 월수금 07:00'],
                          ['0 9 25 * *','매월 25일 09:00']]) {
  const got = describeCron(c);
  ok(got === want, `"${c}" → "${want}"`, `got "${got}"`);
}

console.log(`\n${'='.repeat(50)}\n결과: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
