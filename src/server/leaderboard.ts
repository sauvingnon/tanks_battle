import { mkdirSync, readFileSync, writeFile } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LeaderboardEntry } from '../shared/protocol.js';

/**
 * Доска лидеров живёт в JSON-файле рядом с сервером. Ключ — санитизированный
 * ник, без аккаунтов: сервер не знает, что «Tanky» сегодня — это тот же
 * человек, что и вчера, и совпадение ников путает статистику. Для первой
 * версии это принятый компромисс — заводить настоящие аккаунты того не стоит.
 */
const FILE = fileURLToPath(new URL('../../data/leaderboard.json', import.meta.url));
mkdirSync(dirname(FILE), { recursive: true });

interface Stats {
  wins: number;
  losses: number;
  draws: number;
  kills: number;
}

function load(): Map<string, Stats> {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Stats>;
    return new Map(Object.entries(raw));
  } catch {
    // Файла ещё нет (первый запуск) или он битый — начинаем с пустой доски.
    return new Map();
  }
}

const stats = load();
let saveTimer: NodeJS.Timeout | null = null;

/** Пишем не на каждую запись, а раз в секунду одним снимком — конец раунда не должен ждать диск. */
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = JSON.stringify(Object.fromEntries(stats));
    writeFile(FILE, data, () => {});
  }, 1000);
}

export interface RoundEntry {
  name: string;
  kills: number;
  result: 'win' | 'loss' | 'draw';
}

export function recordRound(entries: RoundEntry[]): void {
  if (entries.length === 0) return;
  for (const entry of entries) {
    const row = stats.get(entry.name) ?? { wins: 0, losses: 0, draws: 0, kills: 0 };
    row.kills += entry.kills;
    if (entry.result === 'win') row.wins++;
    else if (entry.result === 'loss') row.losses++;
    else row.draws++;
    stats.set(entry.name, row);
  }
  scheduleSave();
}

/** Топ по победам, при равенстве — по фрагам. */
export function top(n = 20): LeaderboardEntry[] {
  return [...stats.entries()]
    .map(([name, row]) => ({ name, ...row }))
    .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
    .slice(0, n);
}
