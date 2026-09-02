/**
 * 터미널에서 알람을 관리한다. 봇의 파싱 로직(src/parse.ts)을 그대로 재사용하므로
 * 텔레그램 명령어와 동작이 완전히 동일하다.
 *
 *   npm run cli -- add 평일 08:30 스탠드업
 *   npm run cli -- list
 *   npm run cli -- del 3
 */
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { parseSchedule } = require('../.cli-build/parse');
const { describeCron } = require('../.cli-build/cron');

const TZ = 'Asia/Seoul';

/** wrangler.toml 에서 내 chat_id 를 읽는다 */
function myChatId() {
  const toml = readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8');
  const m = toml.match(/^\s*ALLOWED_CHAT_IDS\s*=\s*"([^"]*)"/m);
  const id = m && m[1].split(',')[0].trim();
  if (!id) {
    console.error('wrangler.toml 에 ALLOWED_CHAT_IDS 가 없습니다. 대상 chat_id를 알 수 없어요.');
    process.exit(1);
  }
  return id;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // SQL 문자열 이스케이프

function sql(command) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'jarvis-db', '--remote', '--command', command, '--json', '--yes'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const [action, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');

if (action === 'add') {
  const p = parseSchedule(arg, TZ, new Date());
  if (!p.ok) { console.error('등록 실패:', p.error); process.exit(1); }
  const rows = sql(
    `INSERT INTO reminders (chat_id, message, cron, timezone, once_at) VALUES (${q(myChatId())}, ${q(p.message)}, ${q(p.cron)}, ${q(TZ)}, ${p.onceAt ? q(p.onceAt) : 'NULL'}) RETURNING id`,
  );
  const when = p.onceAt ? p.onceAt.replace('T', ' ') : describeCron(p.cron);
  console.log(`등록 완료 (#${rows[0].id})  ${when}  →  ${p.message}`);
} else if (action === 'list') {
  const rows = sql('SELECT * FROM reminders ORDER BY id');
  if (!rows.length) return console.log('등록된 알람이 없습니다.');
  for (const r of rows) {
    const when = r.once_at ? r.once_at.replace('T', ' ') : describeCron(r.cron);
    console.log(`#${r.id}  ${when}${r.enabled ? '' : '  (꺼짐)'}\n    ${r.message}`);
  }
} else if (action === 'del') {
  if (!/^\d+$/.test(arg)) { console.error('사용법: npm run cli -- del 3'); process.exit(1); }
  sql(`DELETE FROM reminders WHERE id = ${Number(arg)}`);
  console.log(`#${arg} 삭제했습니다.`);
} else {
  console.log(`사용법:
  npm run cli -- add 평일 08:30 스탠드업 회의
  npm run cli -- add 내일 15:00 병원 예약
  npm run cli -- list
  npm run cli -- del 3`);
}
