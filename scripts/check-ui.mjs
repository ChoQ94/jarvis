/**
 * 웹 UI 의 인라인 스크립트 문법을 검사한다.
 *
 * HTML 이 TypeScript 템플릿 리터럴 안에 있어서, 소스에 `\n` 을 쓰면
 * 빌드 시 진짜 줄바꿈으로 평가된다. 문자열 리터럴 중간에 개행이 들어가면
 * 브라우저에서 SyntaxError 가 나는데, 소스만 봐서는 멀쩡해 보인다.
 * 그래서 '평가된 결과'를 검사해야 한다.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = readFileSync(new URL('../src/web.ts', import.meta.url), 'utf8');

// 템플릿 리터럴 본문을 실제 문자열로 평가한다
function evaluate(name) {
  const re = new RegExp('export const ' + name + ' = `([\\s\\S]*?)`;');
  const m = src.match(re);
  if (!m) throw new Error(`${name} 을 찾지 못했습니다`);
  // 백틱 리터럴을 그대로 재평가 (치환식이 없는 순수 문자열)
  return new Function(`return \`${m[1]}\`;`)();
}

let failed = 0;
const dir = mkdtempSync(join(tmpdir(), 'jarvis-ui-'));

for (const name of ['CHAT_HTML', 'LOGIN_HTML']) {
  const html = evaluate(name);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  if (scripts.length === 0) {
    console.log(`  ${name}: script 없음 (건너뜀)`);
    continue;
  }
  const file = join(dir, `${name}.js`);
  writeFileSync(file, scripts.join('\n;\n'));
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  PASS  ${name} — 인라인 스크립트 ${scripts.length}개 문법 정상`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(String(err.stderr || err).split('\n').slice(0, 6).join('\n'));
  }

}

console.log(failed ? `\n❌ UI 검사 실패 ${failed}건` : '\n✅ UI 검사 통과');
process.exit(failed ? 1 : 0);
