# О репозитории

Рабочая записка, не документация — сама документация в README.

Проект разделён на два репозитория. Здесь — 2D/аркадная линия: плоские карты
(«Холмы», «Долина» и «Промзона» остались картами, но без рельефа), режим
«Реализм» как ось настроек (маркеры/подписи, без засвета и без рельефа),
большие карты (`MapDef.half`). Рельеф, вес танка, вертикальная наводка и всё,
что с ними связано, развиваются отдельно, в
[world_of_tanks_three_js](https://github.com/sauvingnon/world_of_tanks_three_js) —
это форк той же истории на момент разделения.

---

## Как проверять

```bash
npm run typecheck
npm run check:map          # геометрия карт, спавны, проходимость
npm run check:combat       # урон, рикошеты, таран
npm run check:bots         # волны, настройки комнаты, ИИ
npm run check:royale       # BR-слой ИИ: отход в кусты, вызовы сквада, зона
npm run check:effects      # шейдеры частиц
npm run check:smoothness   # предсказание и сглаживание
MAP=7 npm run bench:pve    # как «Холмы» играются против ботов
MAP=8 npm run bench:pve    # «Долина»; MAP=9 — «Промзона»
```

**Это и есть страховка от «сломать аркаду».** Прогон до и после правки — и
«аркада не изменилась» перестаёт быть надеждой. Пользоваться этим обязательно:
числа в проекте настроены друг под друга, и на глаз регрессию не поймать.

Известная ловушка: `check:bots` содержит замер по настенным часам («тик
укладывается в десятую часть бюджета») и **плавает под нагрузкой машины** — если
рядом крутится дев-сервер или что-то тянет Docker, проверка падает без всякой
регрессии. Норма — около 0.049 мс с двенадцатью ботами при бюджете 33.3 мс.
Прежде чем искать баг, перезапустите на спокойной машине.

### Скриншоты игры без установки браузера

Браузера для автоматизации в системе нет (только Safari), но есть Docker.
Рецепт, который работает, — образ Playwright не содержит самого пакета, его надо
доставить внутрь, и `NODE_PATH` для ESM не годится:

```bash
# сервер должен быть поднят: npm run build && npm run start
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/shot.mjs:/app/shot.mjs:ro" -v "$PWD/out:/out" -w /app \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  mcr.microsoft.com/playwright:v1.56.0-noble \
  sh -c "npm i --silent --no-save playwright@1.56.0 >/dev/null 2>&1 && node shot.mjs"
```

Сам `shot.mjs` лежит в репозитории: заходит в комнату, переключает карту
(`SHOT_MAP`, по умолчанию «Холмы»), отъезжает от спавна и снимает оба вида в
`out/`. `chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader',
'--enable-unsafe-swiftshader'] })`, адрес игры — `http://host.docker.internal:8080`.
Селекторы: `#name-input`, `#join-button`, `#setup-toggle`, `button[data-map="7"]`,
`button[data-mode="pve"]`, `button[data-rules="real"]`, подписи — `#labels .nameplate`.

Отъехать от спавна обязательно: спавны стоят у самой стены, и первый кадр — это
кадр бетонной стены во весь экран.

На больших картах (индексы 8 и 9) пригодятся переменные: `SHOT_NAME` (префикс
файлов — иначе снимки разных карт затирают друг друга), `SHOT_DRIVE` (мс вперёд:
на 280 м до простора дальше, чем на 140 м хватало), `SHOT_TURN`/`SHOT_TURN_MS`
(довернуть `a` или `d` перед выездом — не с каждого спавна путь вперёд свободен),
`SHOT_ZOOM` (прокрутка колеса в виде сверху — без неё в кадре один блок во весь
экран). Пример для «Долины»:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/shot.mjs:/app/shot.mjs:ro" -v "$PWD/out:/out" -w /app \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -e SHOT_MAP=8 -e SHOT_NAME=valley \
  -e SHOT_TURN=a -e SHOT_TURN_MS=450 -e SHOT_DRIVE=9000 -e SHOT_ZOOM=6000 \
  mcr.microsoft.com/playwright:v1.56.0-noble \
  sh -c "npm i --silent --no-save playwright@1.56.0 >/dev/null 2>&1 && node shot.mjs"
```

Подписи — это DOM поверх канваса, поэтому в скриншот они попадают независимо от
того, отрисовался ли WebGL.

### Замер интерфейса в живой странице

Рядом лежит `probe.mjs` — тот же рецепт, но вместо снимков он меряет. Панель
настроек: помещается ли она в экран на 1280×720, 900×560 и телефонных 390×700
(и сколько в ней содержимого против окна). Метка прицела: на сколько пикселей
она уезжает между кадрами — стоя и с поворотом башни.

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD/probe.mjs:/app/probe.mjs:ro" -v "$PWD/out:/out" -w /app \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -e PROBE_MODE=dm \
  mcr.microsoft.com/playwright:v1.56.0-noble \
  sh -c "npm i --silent --no-save playwright@1.56.0 >/dev/null 2>&1 && node probe.mjs"
```

`PROBE_MODE=pve` (по умолчанию) выпускает ботов — тогда в замер метки попадают
гибель и возрождение, и скрипт сам пропускает кадры вокруг них. Для чистого
числа берите `dm`: там метку никто не сбивает.

Docker Desktop может быть не поднят — `open -a Docker`, около двадцати секунд.
