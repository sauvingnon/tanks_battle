/** Быстрая проверка десятиволнового забега без поднятия WebSocket-сервера. */
import { MODE_EXPEDITION, TICK_HZ, EXPEDITION_WAVES } from '../src/shared/constants.js';
import { Room, type Player } from '../src/server/room.js';

const room = new Room();
room.setup(MODE_EXPEDITION, 0, false);
room.add('Проверка', () => {});

const internal = room as unknown as { quotaLeft: number };
const bots = (): Player[] => [...room.players.values()].filter((player) => player.brain);

room.update();
if (room.waveState().wave !== 1 || room.waveState().phase !== 'fight') {
  throw new Error('Экспедиция не стартовала с первой волны');
}

for (let wave = 1; wave <= EXPEDITION_WAVES; wave++) {
  for (const bot of bots()) bot.dead = true;
  internal.quotaLeft = 0;
  room.update();

  if (wave < EXPEDITION_WAVES) {
    const state = room.waveState();
    if (state.phase !== 'upgrade' || state.choices?.length !== 3) {
      throw new Error(`После волны ${wave} нет трёх улучшений`);
    }
    room.chooseUpgrade(state.choices[0].id);
    for (let i = 0; i < 2 * TICK_HZ + 1; i++) room.update();
    if (room.waveState().wave !== wave + 1) {
      throw new Error(`После улучшения не началась волна ${wave + 1}`);
    }
  }
}

if (!room.waveState().victory || room.waveState().phase !== 'over') {
  throw new Error('Десятая волна не завершила экспедицию победой');
}

console.log('Экспедиция: все 10 волн и выбор улучшений прошли');
