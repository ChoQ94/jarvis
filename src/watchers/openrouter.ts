/**
 * OpenRouter 신규 모델 감시.
 *
 * '오늘 출시(created)' 대신 '본 적 없는 id' 를 신규로 판단한다.
 * 크론을 한 번 놓치거나 모델이 소급 등록돼도 놓치지 않기 위해서다.
 */
import { sendMessage } from '../telegram';

interface OpenRouterModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

const API = 'https://openrouter.ai/api/v1/models';

/** 'anthropic/claude-x' → 'anthropic'. '~anthropic' 같은 변형 접두사는 벗겨낸다. */
function providerOf(id: string): string {
  return id.split('/')[0].replace(/^~/, '').toLowerCase();
}

function watched(id: string, providers: string[]): boolean {
  const p = providerOf(id);
  return providers.some((w) => p === w || p.startsWith(`${w}-`));
}

/** '0.000003' (토큰당) → '$3.00' (100만 토큰당) */
function perMillion(price?: string): string | null {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  const v = n * 1_000_000;
  return `$${v >= 10 ? v.toFixed(0) : v.toFixed(2)}`;
}

function describe(m: OpenRouterModel): string {
  const bits: string[] = [];
  if (m.context_length) bits.push(`${Math.round(m.context_length / 1000)}K`);
  const inP = perMillion(m.pricing?.prompt);
  const outP = perMillion(m.pricing?.completion);
  if (inP && outP) bits.push(`${inP}/${outP}`);
  else if (!inP && !outP) bits.push('무료');
  return bits.join(' · ');
}

export interface WatchResult {
  checked: number;
  seeded: boolean;
  newIds: string[];
}

export async function checkOpenRouter(
  db: D1Database,
  token: string,
  chatId: string,
  providers: string[],
): Promise<WatchResult> {
  const res = await fetch(API, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);

  const all = ((await res.json()) as { data?: OpenRouterModel[] }).data ?? [];
  const targets = all.filter((m) => m.id && watched(m.id, providers));
  if (targets.length === 0) return { checked: 0, seeded: false, newIds: [] };

  const { results } = await db.prepare('SELECT id FROM seen_models').all<{ id: string }>();
  const known = new Set(results.map((r) => r.id));
  const fresh = targets.filter((m) => !known.has(m.id));

  if (fresh.length === 0) return { checked: targets.length, seeded: false, newIds: [] };

  // 아는 모델이 하나도 없으면 첫 실행이다. 알림 없이 현재 목록만 기록한다.
  const seeding = known.size === 0;

  // D1 파라미터 한도를 고려해 100개씩 나눠 넣는다
  for (let i = 0; i < fresh.length; i += 100) {
    const chunk = fresh.slice(i, i + 100);
    await db
      .prepare(
        `INSERT OR IGNORE INTO seen_models (id) VALUES ${chunk.map(() => '(?)').join(',')}`,
      )
      .bind(...chunk.map((m) => m.id))
      .run();
  }

  if (seeding) {
    console.log(`openrouter: 최초 시딩 ${fresh.length}건 (알림 없음)`);
    return { checked: targets.length, seeded: true, newIds: [] };
  }

  const lines = fresh.map((m) => {
    const meta = describe(m);
    return `• ${m.id}${meta ? `\n   ${meta}` : ''}`;
  });
  const title = fresh.length === 1 ? '🆕 새 모델이 올라왔어요' : `🆕 새 모델 ${fresh.length}개`;
  await sendMessage(token, chatId, `${title}\n\n${lines.join('\n')}\n\nhttps://openrouter.ai/models`);

  return { checked: targets.length, seeded: false, newIds: fresh.map((m) => m.id) };
}
