# Live Browser → Goose v0.4.0 — HANDOFF (перенос)

> Этот файл — инструкция для нового агентного сеанса (завтра). Он создан 2026-11-08 в
> конце рабочего дня. Читай его полностью, затем проверяй реальное состояние проекта
> (`git status`, `git log`, и команды из раздела D) **до** того, как начнёшь менять код.
> Не повторяй многочасовое исследование старой реализации — карта архитектуры уже готова.

---

## A. Цель проекта

Полный перенос **Live Browser** из оригинального Local AI Desktop
(`/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop`, READ-ONLY)
в новый Goose-based Local AI Desktop v0.4.0
(`/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop-goose-040`, рабочий проект).

Live Browser — это встроенная правая панель браузера, в которой:
- пользователь наблюдает **реальную** Playwright Page (ту же, на которой работает агент Goose);
- выделяет прямоугольником области (regions/areas) с названием, описанием, статусом;
- передаёт выделенную область + ограниченный структурированный контекст в чат агенту;
- агент получает MCP-тулзы `browser_*` для управления той же страницей;
- Vision On/Off: изображение присоединяется только если модель поддерживает vision
  (гейтинг уже в Goose: `crates/goose-provider-types/src/formats/openai_responses.rs`).

Главный критерий успеха: пользователь видит браузер, выделяет область, пишет «исправь это»,
а агент получает достаточно достоверного контекста (URL, геометрия, DOM anchors, screenshot/crop,
диагностика Canvas/SVG fallback) чтобы найти и исправить элемент.

---

## B. Текущее состояние (честно, с разграничением уровней)

Уровни: **код написан** → **собирается** → **unit-тесты** → **проверено в реальном Electron** → **проверено E2E**.

### Работает и проверено
- Runtime (Node) **производит кадры**: в этой среде CDP screencast
  (`Page.startScreencast`) **НЕ даёт кадров** (проверено на обоих хостах — plain-node и
  electron-as-node, оба log'ят `CDP screencast produced no frames; switching to polling fallback`).
  Кадры приходят через **polling fallback** (`page.screenshot` каждые 400 мс) — проверено:
  13 кадров за 8 с по SSE. **Вывод: polling — это рабочий путь; CDP screencast здесь не работает,
  но это НЕ критично, fallback покрывает.**
- SSE-доставка кадров работает: сырой `fetch` к `/control/events?conversation=X` читает кадры
  (проверено в A/B-диагностике на обоих node-хостах).
- CORS для renderer (fetch) исправлен: `control.ts` шлёт `access-control-allow-origin: *` +
  `OPTIONS 204` preflight (Authorization header). Renderer больше не роняет `Failed to fetch`.
- Изолированный запуск E2E Electron работает: `XDG_CONFIG_HOME` + `GOOSE_PATH_ROOT` +
  `LOCAL_AI_DESKTOP_DEV_ROOT` → single-instance lock **ACQUIRED**, приложение стартует,
  «React ready», runtime ready, панель подключается (CORS).
- `TSC` и `ESLint` проходят (на затронутых файлах, `max-warnings 0`).
- Unit-тесты (vitest) — база **31/31** (contextBuilder, coords, pendingContext, promptUrl).
  (Не перезапускал сегодня; перепроверить по команде из D.)
- i18n: **62 ключа** в 16 локалях, `i18n:check` PASS.
- Runtime token — `randomBytes(24)` (случайный, не хардкод). В коде нет секретов/ключей
  (проверено grep'ом). Тест-скрипты используют заглушки (`smoke-token-123`, `dbg`).

### Написано и собирается, НО не проверено E2E до конца
- Вся renderer-интеграция: панель, канвас, выделение, передача в чат.
- MCP-интеграция с Goose (регистрация расширения `local-ai-live-browser`).
- Передача выделенной области в агентный контекст (text + images).

### НЕ РАБОТАЕТ / главный blocker
- **E2E test 1 FAIL на `canvasHasContent`**: канвас ПУСТ в реальном Electron, хотя runtime
  (через polling) **производит** кадры и SSE их **доставляет** (сырой fetch читает).
  ⇒ Значит проблема на стороне **RENDERER**: цепочка `EventSource → drawFrame → canvas`
  не выводит кадр. Это ГЛАВНАЯ оставшаяся задача.
- E2E test 2 (агентный round-trip через ту же Qwen) — НЕ пройден (зависит от test 1;
  сейчас `skip`, если llama не найден; seed готов в `goose-seed.ts`).
- Production packaging (`electron-forge make`) — НЕ проверял сегодня.

### Не называть готовым то, что лишь «собирается»
TypeScript/сборка прошли — это НЕ доказательство, что панель отображает браузер.
До green E2E test 1 функциональность screencast-отображения считается **непроверенной в UI**.

---

## C. Архитектура (реальные файлы)

### Поток данных (цель)
```
Goose browser tools (MCP)  →  runtime (Playwright Page)  →  CDP screencast / polling
   →  HTTP control API (127.0.0.1) + SSE  →  renderer canvas  →  пользователь
```
Одна Playwright Page на чат (conversation). Скрытие панели НЕ останавливает Page/агента
(останавливается только SSE-подписка/производство кадров).

### Runtime (Node, отдельный процесс) — `ui/desktop/live-browser/`
- `runtime/main.ts` — bootstrap: control server + MCP + screencast; печатает boot-строку JSON
  `{ok, service, port, dataDir, headless, chrome}` на stdout (main-процесс парсит её).
- `runtime/browser.ts` — `BrowserManager`: один Chromium (системный `/usr/bin/google-chrome`),
  одна `BrowserContext`+`Page`+`CDPSession` на conversation. `captureFrame()` = `page.screenshot`.
  `navigate/back/forward/reload`; валидация URL (блокирует `data:` и т.п., `protocol-not-allowed`).
  `findSystemChrome()`.
- `runtime/screencast.ts` — `ScreencastHub`: CDP `Page.startScreencast` (jpeg q72, everyNthFrame 2,
  maxEdge 3840) → подписчики. Grace 3000 мс: если кадров нет → `startPolling()` (каждые 400 мс,
  `manager.captureFrame`). `setVisible(false)` → suspend (Page живёт, кадры не производятся).
  `subscribe()` стартует `ensureRunning`, стоп при 0 подписчиков (если не suspended).
  **ВАЖНО: в текущей среде CDP screencast не даёт кадров — работают именно polling-кадры.**
- `runtime/control.ts` — HTTP control server (127.0.0.1): `/health`, `/mcp`, `/control/events`
  (SSE), `/control/state`, `/control/active`, `/control/ground`, `/control/area[...]`,
  `/control/region[...]`, `/control/workspace`, `/control/ownership`, `/control/viewport`,
  `/control/visibility`, `/control/navigate`, `/control/act`, `/control/capture`, `/control/read`,
  `/control/scroll`, `/control/projection`, `/control/check`, `/control/session/close`.
  Авторизация: `Bearer <token>` (или `?token=` для SSE, т.к. EventSource не умеет заголовки).
  **CORS + OPTIONS preflight добавлены (критично для cross-origin renderer).**
- `runtime/mcp.ts` — MCP streamable-HTTP сервер (`/mcp`): тулзы `browser_*` (navigate, read, act,
  ground, capture, viewport и т.д.), которые ходят в тот же `BrowserManager`.
- `runtime/grounding.ts` — привязка выделения: DOM anchors (CSS selector, data-testid,
  bounding box, accessibility, nearby context), geometry/viewport/dpr/scroll,
  **Canvas/SVG/WebGL fallback** (диагностика «no source mapping» — НЕ удалять).
- `runtime/regions.ts` — модель areas/regions (id, name, description, status, regions[],
  createdAt, diagnostics, checks, history).
- `runtime/security.ts` — проверка URL/протоколов (нет произвольного file:/data:).
- `runtime/store.ts`, `runtime/util.ts` — хранение + утилиты (`log()` → stdout).
- `shared/types.ts`, `shared/api.ts` — общие типы (LadArea, LadRegion, LadWorkspaceSettings,
  LadControlMeta, LadGroundResponse, ...). `shared/coords.ts` — маппинг координат canvas↔document.
  `shared/context.ts` — **сборка ограниченного контекста для модели** (URL, геометрия, anchors,
  CSS, screenshot-флаг, диагностика). `shared/prompt-url.ts` — валидация/нормализация URL.
- `build.mjs` — esbuild-bundle → `dist/live-browser.js` (CJS, node18, **inlined deps ~8MB**,
  `LIVE_BROWSER_NO_SOURCEMAP=1` отключает map). **`dist/` в .gitignore (генерация, не коммитить).**
- `tests/smoke.mjs` (31/31), `tests/debug-sse.mjs` — локальные smoke/диагностика.
- `package.json`, `browsers.json` (4KB, Playwright config — коммитим), `tsconfig.json`.

### Electron main / preload
- `ui/desktop/src/liveBrowserRuntime.ts` — `LiveBrowserRuntimeManager`: спавнит bundle
  (node-кандидаты: `LAD_LB_NODE` override → electron-as-node `ELECTRON_RUN_AS_NODE=1`
  → node-on-PATH), env: `LAD_LB_TOKEN` (randomBytes24), `LAD_LB_DATA_DIR`, `LAD_LB_HEADLESS=true`,
  опц. `LAD_LB_CHROME_PATH`. Boot handshake по stdout. endpoint `http://127.0.0.1:<port>`.
- `ui/desktop/src/desktopMain.ts` — IPC: `liveBrowserStatus`, `liveBrowserStart`; `will-quit` cleanup.
  Storage/dev-root логика: `XDG_CONFIG_HOME`/`LOCAL_AI_DESKTOP_DEV_ROOT`/`GOOSE_PATH_ROOT`.
  Single-instance lock (~строка 546).
- `ui/desktop/src/preload.ts` — `window.electron.liveBrowser*` (contextIsolation).

### React UI (renderer) — `ui/desktop/src/components/liveBrowser/`
- `useLiveBrowser.ts` (627 строк) — состояние панели одного чата: bootstrap runtime, SSE
  (`EventSource(client.sseUrl(conversationId))`), `attachCanvas`, `drawFrame`
  (`atob` → Blob → `createImageBitmap` → `ctx.drawImage` → `setHasFrame`), все control-операции.
  **Возможный источник bug пустого канваса — именно здесь (EventSource/drawFrame/attachCanvas).**
- `liveBrowserClient.ts` — HTTP-клиент (fetch, `Bearer`), `sseUrl()` (token в query).
- `LiveBrowserPanel.tsx` (766 строк) — панель: `data-testid`s
  (`live-browser-panel`, `live-browser-canvas`, `live-browser-url-input`, `live-browser-open`,
  `live-browser-new-area`, `live-browser-area[-name/-desc/-status/-send]`, ...), `SelectionOverlay`,
  `setPendingSelection(...)`, split/expanded, resize.
- `SelectionOverlay.tsx` — drag-прямоугольник по канвасу → `ground()`.
- `useLiveBrowserWiring.ts` — регистрация MCP-расширения Goose (`ensureLiveBrowserExtension`).
- `liveBrowserExtension.ts` — `LIVE_BROWSER_EXTENSION_NAME='local-ai-live-browser'`;
  `ensureLiveBrowserExtension({url,token})` (идемпотентно); MCP streamable-http, timeout 60000.
- `pendingContext.ts` — глобальная очередь: `setPendingSelection` / `consumePendingSelection` /
  `peekPendingSelection` / `onPendingSelectionChange`. PendingSelection = `{text, images, areaNames, createdAt}`.
- `contextBuilder` (в shared/context.ts) — строит текстовый контекст области.
- `i18n.ts` + `src/i18n/messages/*.json` — 62 ключа, 16 локалей.

### Интеграция в приложение
- `ui/desktop/src/components/Hub.tsx` — пустой чат (landing): browser-toggle + pending-selection-note
  + `<LiveBrowserPanel sessionId="hub" ...>`.
- `ui/desktop/src/components/BaseChat.tsx` — чат: browser-toggle (no-drag, z-[100]),
  per-chat BrowserUIState (localStorage), панель, consumption pending selection.
  Layout fix: чат скрывается только в `expanded` (`browserMode === 'expanded' && 'hidden'`).
- `ui/desktop/src/hooks/useChatSession.ts` — `handleSubmit`: `consumePendingSelection()` →
  `effectiveMessage = pending.text + '\n\n' + userMessage`; `effectiveImages = [...images, ...pending.images]`.

### Goose-интеграция (Rust) — НЕ менялись для этой фичи
- MCP-расширение регистрируется из renderer через конфиг Goose (streamable-http).
- Vision-гейтинг: `crates/goose-provider-types/src/formats/openai_responses.rs`
  (`supports_vision` → сохраняет изображение, иначе `'[image omitted...]'`). **Не слать
  изображение модели без vision.**

### E2E-инфраструктура — `ui/desktop/tests/e2e/`
- `fixtures.ts` — `LAD_E2E_ISOLATE=1`: изоляция `LOCAL_AI_DESKTOP_DEV_ROOT`,
  `GOOSE_DISABLE_KEYRING=true`, `XDG_CONFIG_HOME` (пустой temp), непустой `<devRoot>/electron`
  (legacy root), `GOOSE_PATH_ROOT=<devRoot>/goose-backend`; `connectOverCDP` (debug port).
- `app-launcher.ts` — `launchApp()`: пnpm падает на `ERR_PNPM_UNSUPPORTED_ENGINE`
  (system node v22.22.3 vs ^24.10.0) → **direct-node fallback chain**
  (`node scripts/i18n-compile.js || true && node live-browser/build.mjs || true && electron-forge start`).
- `goose-seed.ts` — `discoverLlamaServer()` (читает `/proc/<pid>/cmdline`+`environ`:
  `--port/--alias/LLAMA_API_KEY`); `seedGooseBackend(devRoot, endpoint)` пишет
  `<devRoot>/goose-backend/config/custom_providers/custom_e2e_local_qwen.json` + config/secrets
  (provider `custom_e2e_local_qwen`, secret `CUSTOM_E2E_LOCAL_QWEN_API_KEY`, engine openai,
  model `local-gguf`). **НЕ грузит вторую модель — указывает на уже работающий llama-server.**
- `live-browser.spec.ts` — 2 теста:
  1. panel + navigate + screencast + region selection + pending context (сейчас **FAIL** на канвасе);
  2. agent round-trip (reply должен упоминать содержимое страницы; `skip` если нет llama).

---

## D. Тестирование — точные команды и последние результаты

Рабочий dir для UI: `cd /media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop-goose-040/ui/desktop`.
Бинарники через hoisted: `../node_modules/.bin/...` (pnpm workspace, `../node_modules`).

| Что | Команда | Последний результат |
|---|---|---|
| Unit (vitest) | `../node_modules/.bin/vitest run` | **31/31 PASS** (база; перепроверить) |
| Typecheck | `../node_modules/.bin/tsc --noEmit` | **PASS** (на затронутых) |
| ESLint | `../node_modules/.bin/eslint "src/**/*.{ts,tsx}" --max-warnings 0` | **PASS** |
| i18n | `node scripts/i18n-compile.js` + `node scripts/i18n-check.js` (см. package.json `i18n:*`) | **PASS** (62 ключа) |
| Runtime smoke | `node live-browser/tests/smoke.mjs` | **31/31 PASS** |
| **E2E test 1** | `DEBUG_TESTS=1 ../node_modules/.bin/playwright test tests/e2e/live-browser.spec.ts -g "panel, navigation, screencast" --reporter=list --retries=0` | **FAIL** (`canvasHasContent` → empty canvas) |
| **E2E test 2** (agent) | `DEBUG_TESTS=1 ../node_modules/.bin/playwright test tests/e2e/live-browser.spec.ts -g "agent round-trip" --reporter=list --retries=0` | **NOT VERIFIED** (зависит от test 1) |
| Packaging | `LIVE_BROWSER_NO_SOURCEMAP=1 node live-browser/build.mjs && ../node_modules/.bin/electron-forge make` | **NOT RUN** |

### Проблема изолированного Electron и РЕШЕНИЕ (запомнить)
Запускать изолированный тестовый Electron при уже работающем приложении без конфликта
single-instance lock и глобального хранилища:
- `XDG_CONFIG_HOME` → пустой temp-dir (иначе storage-config подхватывает глобальный);
- непустой `<LOCAL_AI_DESKTOP_DEV_ROOT>/electron` (legacy root);
- `GOOSE_PATH_ROOT=<devRoot>/goose-backend` (изолированная goose-конфига);
- `GOOSE_DISABLE_KEYRING=true`;
- `LOCAL_AI_DESKTOP_DEV_ROOT` = корень изоляции (userData + goose backend).
Итог: `single-instance lock: ACQUIRED`, приложение стартует, React ready, runtime ready.
**E2E всё ещё НЕ проходит полностью (test 1 FAIL на канвасе) — это честно фиксирую.**

### Ключевые диагностические выводы (не переоткрывать)
1. CDP screencast в этой среде НЕ даёт кадров → работает **polling fallback** (это нормально).
2. Runtime **производит** и **доставляет** кадры (сырой `fetch` SSE читает 13 кадров/8с на
   обоих node-хостах). Значит runtime ОК.
3. Пустой канвас ⇒ проблема в **renderer** (EventSource → drawFrame → canvas). Скорее всего:
   EventSource в Electron renderer не доставляет / disconnect-reconnect; ИЛИ `attachCanvas`
   до кадров; ИЛИ `createImageBitmap`. Проверить через console renderer.
4. Electron (хост) в E2E роняет `GPU process launch failed` / `FATAL: GPU process isn't usable`
   — это GPU-процесс самого Electron в headless-среде, НЕ runtime-Chrome (runtime на
   `/usr/bin/google-chrome` работает, кадры приходят через polling).

---

## E. Незавершённая работа (приоритеты)

### 1. ГЛАВНЫЙ шаг завтра — починить пустой канвас в renderer
Ближайший конкретный шаг:
- Добавить в `useLiveBrowser.ts` **debug-лог** (console): EventSource `onopen`/`onerror`,
  счётчик принятых кадров, `drawFrame` success/fail, `canvasRef.current` null-чеk,
  результат `createImageBitmap`.
- В `tests/e2e/fixtures.ts` ловить console renderer: `page.on('console', ...)` +
  `page.on('pageerror', ...)` в лог (сейчас их нет).
- Renderer — это Vite (через `electron-forge start`), **bundle не пересобирать**;
  достаточно перезапустить E2E.
- Перезапустить E2E test 1 и читать console → найти точное место обрыва.
- Альтернативный ROBUST fix (если EventSource хрупкий): **renderer-side polling fallback** —
  каждые ~1.5 с, если кадр не пришёл, сделать `POST /control/capture` (полный кадр без rect —
  проверить, поддерживает ли; если нет — добавить endpoint `captureFull`) и `drawFrame` результат.

### 2. Прогнать E2E test 1 до green.

### 3. E2E test 2 (агентный round-trip, та же Qwen, llama 45383)
- Убедиться, что это **короткая последовательная** сессия (не параллельная нагрузка на GPU).
- `goose-seed.ts` уже указывает custom provider на работающий llama-server; НЕ грузить вторую модель.
- Проверить, что reply упоминает содержимое тестовой страницы; проверить Vision Off (текст)
  и, при наличии, Vision On (изображение).

### 4. Перепроверить unit (vitest run), TSC, ESLint после правок renderer.

### 5. Production packaging: `electron-forge make` → проверить, что `live-browser` (dist+browsers.json)
попал в `resources/`. (Сначала `build:live-browser`.)

### 6. Git commit + push (см. G) — **уже выполняется сегодня**.

### 7. Финальный отчёт (14 пунктов, RU) — **ещё не написан**; handoff покрывает состояние.

> Не включать в «задачи» уже готовое (см. B «Работает и проверено»).

---

## F. Безопасность и ограничения (ОБЯЗАТЕЛЬНО)

- **Не завершать и не перенастраивать основной `llama-server`** (PID **22290**, port **45383**,
  `--alias local-gguf`, ctx 174080, cache q8_0). Он обслуживает МОЮ (агента) сессию.
- **Не выгружать** текущую `Qwen3.8-27B` (`qwen3.8-27b-q4_K_M.gguf`).
- **Не запускать вторую копию весов в GPU/VRAM.** E2E-агент ходит на тот же endpoint (короткие
  последовательные запросы).
- Не трогать managed inference proxy (PID **17799**) и Electron моей сессии.
- Тестовый Goose — **только изолированный профиль** (`XDG_CONFIG_HOME`, `GOOSE_PATH_ROOT`,
  `LOCAL_AI_DESKTOP_DEV_ROOT`).
- Тесты не должны трогать пользовательские данные/сеансы.
- Оригинальный репозиторий `/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop` — **READ-ONLY**.
- **Запрещены широкие `pkill`** по именам electron/node/goose/llama. Убивать тестовые процессы
  только по проверенному PID + подтверждённой принадлежности/изоляции.
- Ограниченная VRAM и параллельные слоты llama-server: не создавать второй полный KV-cache.
- Не слать изображение модели без vision (гейтинг в `openai_responses.rs`).
- Не допускать обхода разрешений Goose через DOM/URL/screenshot/пути.

---

## G. Git

- Рабочая ветка: **`feature/goose-live-browser`** (не `main`, не `migration/v0.4.0-goose`).
- Чекпоинт ДО сегодняшней работы: `c1bc1a5` («chore: checkpoint storage, i18n and autonomous-runtime work before Live Browser migration»).
- Сегодняшний коммит Live Browser: **см. `git log` после коммита** (SHA фиксируется в финальном сообщении).
- Remote: `origin` = `git@github-kushch:Kushch-Yaroslav/local-ai-desktop.git`.
- Push: **без force, без переписывания истории**; не merge в main; не tag/Release.
- В коммит **НЕ** попали: `live-browser/dist/` (gitignore, генерация), `node_modules`,
  `out/`, `test-results/`, `playwright-report/`, i18n compiled, GGUF-веса, секреты.
- (Сегодня заодно убраны 2 осиротевших тестовых runtime-процесса (PID 94818, 95186) —
  их Chromium-дети уже завершились; основной llama-server 22290 и proxy 17799 не тронуты.)

---

## Prompt for next session

> Продолжи перенос Live Browser в Goose v0.4.0. Сначала **полностью прочитай**
> `/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop-goose-040/docs/development/LIVE_BROWSER_HANDOFF.md`
> (он содержит карту файлов, уровни готовности, безопасные ограничения и точные команды).
> Затем **проверь реальное состояние**: в `ui/desktop/` выполни `git status`, `git log -3 --oneline`,
> `git branch --show-current`, и подтверди, что на ветке `feature/goose-live-browser` и все файлы на месте.
>
> **Не начинай заново исследование старой реализации.** Начни с ГЛАВНОГО незавершённого шага (раздел E.1):
> починить **пустой канвас в renderer** — добавь debug-лог в `useLiveBrowser.ts` (EventSource onopen/onerror,
> счётчик кадров, drawFrame, attachCanvas, createImageBitmap), в `tests/e2e/fixtures.ts` добавь
> `page.on('console')`/`page.on('pageerror')`, перезапусти E2E test 1 (команда в разделе D) и по console
> найди, где обрывается доставка/отрисовка кадров. Runtime уже подтверждён рабочим (кадры идут через
> polling fallback, сырой fetch SSE их читает) — не трать время на runtime.
>
> Строго соблюдай раздел F: НЕ трогай основной llama-server (PID 22290, port 45383), managed proxy (PID 17799),
> не грузи вторую копию модели в VRAM, тестовый Goose — только изолированный профиль,
> широкий pkill запрещён, оригинальный репозиторий read-only.
>
> После green E2E test 1 → test 2 (агент, короткая сессия на том же llama), затем unit/TSC/ESLint,
> packaging (`electron-forge make`), commit + push в `feature/goose-live-browser` (без merge/tag/force),
> и напиши финальный отчёт на русском (14 пунктов) в конец handoff-файла.

---

# H. ФИНАЛЬНЫЙ ОТЧЁТ (2026-11-08) — 14 пунктов

> **Статус: Live Browser перенесён и РАБОТАЕТ.** Оба E2E-теста green,
> упаковка проверена, закоммичено и запушено в `feature/goose-live-browser`.
> Все пункты ниже — с реальными файлами, механизмами и проверенными результатами.

## 1. Что перенесено
Live Browser из оригинального Local AI Desktop перенесён в Goose-based v0.4.0 как
полнофункциональная фича: live-панель браузера в правой части окна, выделение областей
(приоритет), передача выделенного контекста агенту, управление браузером через
MCP-инструменты Goose, интеграция с чатом (и empty-chat). Файлы:
- `ui/desktop/live-browser/` — runtime (Node-процесс): `runtime/` (main.ts, browser.ts,
  screencast.ts, control.ts), `shared/`, `build.mjs`.
- `ui/desktop/src/components/liveBrowser/` — React UI: `LiveBrowserPanel.tsx`,
  `useLiveBrowser.ts`, `SelectionOverlay.tsx`, `liveBrowserClient.ts`, `pendingContext.ts`,
  `useLiveBrowserWiring.ts`, i18n (62 ключа / 16 локалей).
- `ui/desktop/src/liveBrowserRuntime.ts` — main-process менеджер рантайма.
- `ui/desktop/src/components/Hub.tsx` + `BaseChat.tsx` — встраивание в приложение.

## 2. Архитектура (критическое требование)
`Goose browser tools → Playwright Page → CDP screencast → Live Browser UI`.
Агент и пользователь видят **ОДИН реальный Playwright Page**: `BrowserManager` держит один
Chromium (системный `/usr/bin/google-chrome`) + одну Page на conversation.
**Скрытие панели НЕ останавливает агента** — останавливается только SSE-подписка/производство
кадров (`ScreencastHub.setVisible(false)` → suspend, Page живёт). Второй независимый
Electron-инстанс для отображения **НЕ создаётся**.

## 3. Выделение областей (приоритетная фича)
Пользователь рисует прямоугольник на канвасе (`SelectionOverlay`), создаёт область с
name/description/status (`createArea`/`updateArea`), хранит несколько областей. Координаты
маппятся в page-координаты (`coords.ts`), область ground-уется (`/control/ground`).
UI: `LiveBrowserPanel.tsx`.

## 4. Передача области агенту
Выбранная область собирается в **ограниченный структурированный контекст**
(`buildAreaContextText` in `live-browser/shared/context.ts`) + необязательные crop-изображения
(`/control/capture`), ставится в очередь `pendingContext.ts`. `useChatSession.ts`
(`handleSubmit`) подключает её к следующему сообщению:
`effectiveMessage = pending.text + userMessage`, `effectiveImages = [...images, ...pending.images]`.
Агент получает надёжный структурированный контекст (проверено E2E test 2).

## 5. Vision On/Off
Текст **всегда** прикладывается; изображение — необязательно. Goose гейтит изображение по
`supports_vision` в `crates/goose-provider-types/src/formats/openai_responses.rs` (если модели
нет vision — картинка заменяется `[image omitted...]`). Изображение **не слать** модели без
vision — соблюдено. Диагностический fallback: `Screenshot-only Canvas/SVG region; no source mapping`.

## 6. Управление браузером
`liveBrowserClient.ts` + runtime `control.ts`: `navigate` (open/back/forward/reload), `act`
(click/type/press), `read`, `scroll`, `capture` (crop), `liveProjection`, `recordCheck`,
`viewport`/`ownership`/`visibility`. URL-валидация блокирует `data:` и не-http(s)
(`browser.ts` — `context.route` aborts).

## 7. Панель и режимы
Иконка в правом верхнем углу (`.no-drag`, `z-[100]`), правая панель, ресайз (drag), режимы
**Split / Expanded / Chat Only**, скрытие панели без остановки агента, **per-chat состояние**
(BaseChat: BrowserUIState в localStorage; Hub: для empty-chat). Минималистичный стиль Goose
(Tailwind + существующие UI-компоненты).

## 8. Работа без выбранного проекта
Live Browser доступен и в empty-chat (Hub): `LiveBrowserPanel sessionId="hub"` + browser-toggle.
E2E test 1 проверяет именно этот путь.

## 9. E2E-тестирование (та же Qwen, llama-server не тронут)
Оба теста **green**:
- **test 1** (panel/navigation/screencast/region/pending context): **PASS 48.6s**. Кадры
  отрисовываются на канвасе; watchdog переключается на polling fallback.
- **test 2** (agent round-trip): **PASS 1.4m**. Модель получила выделенную область и ответила,
  упомянув содержимое страницы (`e2e-token-4242`, info card).
- Использован тот же llama-server (PID 4994, port 34267, alias `local-gguf`,
  `qwen3.8-27b-q4_K_M.gguf`); `n_slots=4`, `kv_unified` → короткая последовательная сессия
  memory-safe; вторая копия весов в VRAM **НЕ грузилась**.

## 10. Unit-тесты + TSC + ESLint
Unit (live-browser): **31/31 passed** (contextBuilder, coords, pendingContext, promptUrl).
**TSC EXIT 0**. **ESLint EXIT 0** на всех изменённых файлах (исправлены `no-undef NodeJS`,
`no-self-assign`).

## 11. Production packaging
`electron-forge package` **EXIT 0**. `live-browser.js` + `browsers.json` + `package.json`
попадают в `resources/` (flat layout @electron/packager). **Исправлен packaging bug**:
`runtimeScriptPath()` теперь пробует dev / nested / flat layout — упакованное приложение
находит `resources/live-browser.js`. Node-рантайм в packaged: `resources/bin/node`
(bundled launcher).

## 12. Сохранность конфигурации
Не тронуто: GGUF-модели, managed llama.cpp runtime, Maximum Context Discovery, сессии, профили,
storage, миграции, dev launcher, AppArmor, CUDA, внешний llama.cpp. Основной llama-server
(**PID 4994**) **НЕ тронут, НЕ завершён, НЕ перенастроен**. Оригинальный репозиторий
(`/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop`) — **READ-ONLY**, не изменён.

## 13. Git
Ветка `feature/goose-live-browser`. Коммиты: `f21e413` (port WIP) + `2c9c65b` (fixes:
empty canvas, screencast stall, packaged path, lint, dev-gated diagnostics). Push в
`origin` = `git@github-kushch:Kushch-Yaroslav/local-ai-desktop.git` (`f21e413..2c9c65b`).
**Без** merge в main, **без** tag/Release, **без** force push / reset --hard. В коммит **не
попали**: `live-browser/dist/`, `node_modules`, `out/`, `test-results/`, i18n compiled, GGUF,
секреты.

## 14. Ограничения / что осталось
- CDP screencast (`Page.startScreencast`) в этой среде не даёт кадров — работает **polling
  fallback** (`page.screenshot` / 400 мс). Это нормально (UI живой), но при желании можно искать
  причину (headless/GPU). Не критично.
- E2E test 2 — короткая последовательная сессия на том же llama; при параллельных агентах нужна
  осторожность с VRAM (n_slots / kv_unified).
- `resources/package.json` (live-browser manifest) в flat layout — безопасно (Electron читает
  `app.asar/package.json`), но при желании можно перевести на nested layout.
- Rust-изменений для фичи не требуется (vision-гейтинг уже в `openai_responses.rs`);
  cargo fmt/clippy не запускались (Rust-файлы не менялись).
- Рекомендуется: прогнать `electron-forge make` (инсталляторы deb/rpm/flatpak) в CI/на целевой
  платформе — `package` проверен локально.

## Изменения за 2026-11-08 (5 файлов, коммит `2c9c65b`)
- `ui/desktop/src/components/liveBrowser/useLiveBrowser.ts` — `latestFrameRef` + catch-up
  redraw + `renderFrameTo` + dev-gated `LBDBG` diagnostics.
- `ui/desktop/src/components/liveBrowser/LiveBrowserPanel.tsx` — callback ref
  (`handleCanvasRef`) для надёжной attach канваса (корень пустого канваса).
- `ui/desktop/live-browser/runtime/screencast.ts` — watchdog (`lastFrameAt`) → polling fallback
  при stall; таймеры `ReturnType<typeof setTimeout>`; убран self-assign.
- `ui/desktop/src/liveBrowserRuntime.ts` — `runtimeScriptPath()` multi-candidate (dev/nested/flat).
- `ui/desktop/tests/e2e/fixtures.ts` — catch renderer console/pageerror для `LBDBG`.

## Примечание по PIDs (раздел F устарел)
PID'ы сессий **меняются между запусками**. Текущая сессия (2026-11-08): llama-server
**PID 4994**, port **34267** (alias `local-gguf`). Всегда обнаруживать заново через
`pgrep -a llama-server` / `curl localhost:PORT/health`, **никогда не хардкодить**.
`discoverLlamaServer()` в `goose-seed.ts` — динамический (ок).
