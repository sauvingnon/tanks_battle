/** Быстрая проверка пятнадцативолнового забега без поднятия WebSocket-сервера. */
import { EXPEDITION_WAVES, MAX_HP, MODE_EXPEDITION, TICK_HZ } from '../src/shared/constants.js';
import { Room, type Player } from '../src/server/room.js';

const room = new Room();
room.setup(MODE_EXPEDITION, 0, false);
room.add('Проверка', () => {});

const internal = room as unknown as { quotaLeft: number };
const bots = (): Player[] => [...room.players.values()].filter((player) => player.brain);
const hero = [...room.players.values()].find((player) => !player.brain);
if (!hero) throw new Error('В экспедиции не создан игрок');
let healthUpgradeSeen = false;

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
    const choice = state.choices.find((upgrade) => upgrade.health > 1) ?? state.choices[0];
    room.chooseUpgrade(choice.id);
    if (choice.health > 1) {
      healthUpgradeSeen = true;
      if (hero.hp !== Math.round(MAX_HP * (room.waveState().health ?? 1))) {
        throw new Error('Улучшение здоровья не подняло максимальный HP');
      }
    }
    for (let i = 0; i < 2 * TICK_HZ + 1; i++) room.update();
    if (room.waveState().wave !== wave + 1) {
      throw new Error(`После улучшения не началась волна ${wave + 1}`);
    }
  }
}

if (!room.waveState().victory || room.waveState().phase !== 'over') {
  throw new Error('Пятнадцатая волна не завершила экспедицию победой');
}
if (!healthUpgradeSeen) throw new Error('За забег не встретилось улучшение здоровья');

console.log('Экспедиция: все 15 волн и выбор улучшений прошли');
