/**
 * Разовая проверка правок в живой странице: панель настроек и метка прицела.
 * Запускается тем же рецептом, что и shot.mjs, — см. CONTEXT.md.
 */
import { chromium } from 'playwright';

const URL = process.env.PROBE_URL ?? 'http://host.docker.internal:8080';
const OUT = process.env.PROBE_OUT ?? '/out';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.fill('#name-input', 'Проба');
await page.click('#join-button');
await page.waitForTimeout(1500);

// --- Панель настроек: помещается ли она в экран ---
async function panelFit(label) {
  const box = await page.evaluate(() => {
    const el = document.getElementById('setup');
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      view: window.innerHeight,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
  const fits = box.bottom <= box.view + 0.5;
  const scrolls = box.scrollHeight > box.clientHeight + 1;
  console.log(
    `панель ${label}: низ ${box.bottom.toFixed(0)} при экране ${box.view} — ` +
      `${fits ? 'помещается' : 'ТОРЧИТ'}${scrolls ? ', прокручивается' : ''} ` +
      `(содержимое ${box.scrollHeight}, окно ${box.clientHeight})`,
  );
  return fits;
}

await page.click('#setup-toggle');
await page.waitForTimeout(400);
await page.click(`button[data-mode="${process.env.PROBE_MODE ?? 'pve'}"]`);
await page.waitForTimeout(700);
await page.click('button[data-map="8"]');
await page.waitForTimeout(900);

let ok = true;
ok = (await panelFit('1280x720')) && ok;
await page.screenshot({ path: `${OUT}/panel-720.png` });

await page.setViewportSize({ width: 900, height: 560 });
await page.waitForTimeout(300);
ok = (await panelFit('900x560')) && ok;
await page.screenshot({ path: `${OUT}/panel-560.png` });

await page.setViewportSize({ width: 390, height: 700 });
await page.waitForTimeout(300);
ok = (await panelFit('390x700 (телефон)')) && ok;
await page.screenshot({ path: `${OUT}/panel-phone.png` });

await page.setViewportSize({ width: 1280, height: 720 });
await page.waitForTimeout(300);
await page.click('#setup-toggle');
await page.waitForTimeout(800);

// --- Метка прицела: дрожит ли она в бою ---
await page.mouse.click(640, 360); // захват мыши
await page.keyboard.down('w');
await page.waitForTimeout(3500);
await page.keyboard.up('w');

// Ведём башню и пишем, куда прыгает метка между кадрами.
const jitter = await page.evaluate(async () => {
  const el = document.getElementById('crosshair');
  const jumps = [];
  let prev = null;
  let skipped = 0;
  // После гибели танк возрождается в другом месте, и метка честно переезжает
  // туда вместе с ним. К дрожи это отношения не имеет: пропускаем кадры вокруг
  // каждого исчезновения метки.
  let cooldown = 0;
  const read = () => {
    if (el.hidden) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  };
  await new Promise((done) => {
    let frames = 0;
    const tick = () => {
      const now = read();
      if (!now) cooldown = 20;
      else if (cooldown > 0) cooldown--, skipped++;
      else if (prev) jumps.push(Math.hypot(now.x - prev.x, now.y - prev.y));
      prev = now;
      if (++frames < 420) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  jumps.sort((a, b) => a - b);
  return {
    frames: jumps.length,
    skipped,
    worst: jumps.at(-1) ?? 0,
    p99: jumps[Math.floor(jumps.length * 0.99)] ?? 0,
    median: jumps[Math.floor(jumps.length * 0.5)] ?? 0,
  };
});

// Пока идёт замер, крутим башню мышью: без этого метка стоит на месте.
console.log(
  `метка: кадров ${jitter.frames} (пропущено ${jitter.skipped}), ` +
    `медиана ${jitter.median.toFixed(1)} px, ` +
    `99-й ${jitter.p99.toFixed(1)} px, худший ${jitter.worst.toFixed(1)} px`,
);

await page.screenshot({ path: `${OUT}/aim-chase.png` });

// Ещё раз, но с активным поворотом башни — самый неприятный случай для метки.
const swept = await page.evaluate(async () => {
  const el = document.getElementById('crosshair');
  const jumps = [];
  let prev = null;
  let skipped = 0;
  let cooldown = 0;
  const read = () => {
    if (el.hidden) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  };
  await new Promise((done) => {
    let frames = 0;
    const tick = () => {
      window.dispatchEvent(new MouseEvent('mousemove', { movementX: 9, movementY: 0 }));
      const now = read();
      if (!now) cooldown = 20;
      else if (cooldown > 0) cooldown--, skipped++;
      else if (prev) jumps.push(Math.hypot(now.x - prev.x, now.y - prev.y));
      prev = now;
      if (++frames < 420) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  jumps.sort((a, b) => a - b);
  return {
    frames: jumps.length,
    skipped,
    worst: jumps.at(-1) ?? 0,
    p99: jumps[Math.floor(jumps.length * 0.99)] ?? 0,
    median: jumps[Math.floor(jumps.length * 0.5)] ?? 0,
  };
});
console.log(
  `метка с поворотом башни: кадров ${swept.frames} (пропущено ${swept.skipped}), ` +
    `медиана ${swept.median.toFixed(1)} px, ` +
    `99-й ${swept.p99.toFixed(1)} px, худший ${swept.worst.toFixed(1)} px`,
);
await page.screenshot({ path: `${OUT}/aim-swept.png` });

console.log(ok ? 'ПАНЕЛЬ ОК' : 'ПАНЕЛЬ ПЛОХО');
await browser.close();
