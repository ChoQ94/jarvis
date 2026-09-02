import { readFileSync } from 'node:fs';

/** .dev.vars 또는 환경변수에서 값을 읽는다. 토큰이 코드나 셸 히스토리에 남지 않게 하기 위함. */
export function readVar(name) {
  if (process.env[name]) return process.env[name];

  try {
    const file = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of file.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && m[1] === name) return m[2];
    }
  } catch {
    // .dev.vars 없음 → 아래에서 안내
  }

  console.error(`${name} 를 찾을 수 없어요.`);
  console.error(`.dev.vars 파일에 넣거나, 환경변수로 넘겨주세요:`);
  console.error(`  ${name}="값" npm run <script>`);
  process.exit(1);
}
