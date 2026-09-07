/**
 * Снимок игры без установленного браузера: страница открывается в контейнере
 * Playwright, адрес хоста — host.docker.internal. Рецепт запуска — в CONTEXT.md.
 */
import { chromium } from 'playwright';

const URL = process.env.SHOT_URL ?? 'http://host.docker.internal:8080';
const MAP = process.env.SHOT_MAP ?? '7';
const OUT = process.env.SHOT_OUT ?? '/out';

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
await page.keyboard.down('w');
await page.waitForTimeout(4500);
await page.keyboard.up('w');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/hills-chase.png` });

// Вид сверху той же карты.
await page.keyboard.press('v');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/hills-top.png` });

console.log('снимки готовы');
await browser.close();
