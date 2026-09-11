/**
 * Снимок игры без установленного браузера: страница открывается в контейнере
 * Playwright, адрес хоста — host.docker.internal. Рецепт запуска — в CONTEXT.md.
 */
import { chromium } from 'playwright';

const URL = process.env.SHOT_URL ?? 'http://host.docker.internal:8080';
const MAP = process.env.SHOT_MAP ?? '7';
const OUT = process.env.SHOT_OUT ?? '/out';
/** Префикс файлов: снимков карт стало больше одной. */
const NAME = process.env.SHOT_NAME ?? `map${MAP}`;
/** Сколько ехать от спавна, мс: на больших картах до простора дальше. */
const DRIVE = Number(process.env.SHOT_DRIVE ?? 4500);
/** Довернуть перед выездом: a или d, мс. Иначе с иного спавна упираешься в блок. */
const TURN = process.env.SHOT_TURN ?? '';
const TURN_MS = Number(process.env.SHOT_TURN_MS ?? 600);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Снимок');
await page.click('#join-button');
await page.waitForTimeout(1500);

await page.click('#setup-toggle');
await page.click(`button[data-map="${MAP}"]`);
await page.waitForTimeout(600);
await page.click('#setup-toggle');
await page.waitForTimeout(800);

// Отъезжаем от спавна к середине карты: у стены видно только стену.
if (TURN) {
  await page.keyboard.down(TURN);
  await page.waitForTimeout(TURN_MS);
  await page.keyboard.up(TURN);
}
await page.keyboard.down('w');
await page.waitForTimeout(DRIVE);
await page.keyboard.up('w');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/${NAME}-chase.png` });

console.log('снимки готовы');
await browser.close();
