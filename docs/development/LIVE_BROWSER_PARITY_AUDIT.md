# Live Browser: аудит паритета (2026-11-08)

Статус: исследование исходников завершено до изменения реализации. Полный паритет НЕ подтверждён. Оригинал `/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop` использован только для чтения. Исторические утверждения HANDOFF не являются результатами текущей проверки.

## 1. Архитектура оригинала

`src/main/web/live-browser.ts:LiveBrowserHub.observer/ready/watch/reconcile/end` связывает owner WebContents + conversation + generation с одной Page. Проверка generation не позволяет завершению старого запуска закрыть новую сессию; authorizedEntry проверяет владельца окна. `src/main/web/native-project-page.ts:createNativeProjectPage` создаёт изолированную Electron session и WebContentsView, подключает Playwright chromium.connectOverCDP через debugger transport. Текущий оригинал НЕ использует screencast: нативная поверхность показывает ту же Page без кодирования/декодирования кадров. Shield отделяет ввод агента от пользовательского ввода. Hide снимает bounds, сохраняя Page; destruction owner завершает связанные ресурсы. watch переключает viewer и приостанавливает старые controls. shutdownAll закрывает всё с ожиданием.

`native-project-page.ts` schedule вычисляет CSS viewport, browser zoom, displayScale, DPR и pan отдельно; Emulation.setDeviceMetricsOverride масштабирует поверхность, capturePage не меняет live viewport. Ограничения custom viewport 240..4096 и 8 847 360 пикселей. Input разрешён только user + visible; изменение физических параметров также требует user ownership. Ошибки и freshness передаются через IPC state.

## 2. Layout оригинала

`src/renderer/components/LiveBrowser.tsx:LiveBrowserWorkspace`: split/expanded/chat, per-conversation choices, drag chat share 25..75%, keyboard separator, ResizeObserver при ширине <680 переключает split в browser-first. `BrowserWorkspaceControls.tsx`: Auto/Mobile/Tablet/Desktop/FHD/4K/custom, page zoom, fit/fixed preview, pan/reset. Два layout инструментов, toolsCollapsed, горизонтальная ширина 220..520, автоматическая вертикальная компоновка при browser <650. Workspace сохраняется через `src/main/ipc/register-ipc.ts` → database visual document. CSS `src/renderer/styles/app.css` (live-workspace/browser-tools) использует grid с ограниченным overflow. Отдельное browser window в исследованной реализации не обнаружено: BrowserWindow.fromWebContents используется для прикрепления View к существующему окну, не popout.

## 3. Visual debugging оригинала

`src/main/web/visual-selection.ts:selectionOverlay/groundRegion`: pointer → viewport CSS rect → document CSS rect + scroll, bounded DOM scan 8000, selectors/identity, computed styles, neighbors, findings и surroundings. Canvas/SVG (включая WebGL canvas) дают screenshot-only, не выдумывают source mapping. `src/shared/browser-coordinates.ts`, `browser-anchor.ts` отвечают за преобразования и повторное разрешение anchors. `src/main/services/visual-debugging.ts:command` управляет new-area/selection/group/delete/reveal/navigate/display/color/detect/recheck/workflow. Документ хранит crops, события, статусы, источники evidence, deleted references. Recheck привязан к исходным URL/viewport/anchors и source revision/verification ledger: статус модели сам по себе не доказательство. `VisualDebugPanel.tsx:transfer` ставит выбранные регионы в composer; Vision и текстовый grounding различаются. `register-ipc.ts` связывает visualScope с проектом и чатом и передаёт visionMode в агент. Hidden browser продолжает задачу; диагностический chat reader не захватывает ownership и имеет read-only scope.

## 4. Архитектура переноса

`ui/desktop/live-browser/runtime/browser.ts:BrowserManager` — внешний system Chromium, context+Page+CDPSession на conversation. `screencast.ts:ScreencastHub` → CDP JPEG с ack, watchdog → screenshot polling 400ms → `control.ts` SSE → `useLiveBrowser.ts:renderFrameTo` createImageBitmap/canvas. HTTP bearer на loopback, SSE token query. `runtime/mcp.ts` даёт browser_* на том же manager. `regions.ts/store.ts` JSON-хранилище областей отдельно от Page. `src/liveBrowserRuntime.ts` ищет Node, запускает bundle с boot handshake. Forge extraResource копирует файлы по basename: старый nested-only launcher не найдёт flat bundle. Последний 2c9c65b добавляет flat lookup, но direct Forge build не гарантирует свежий runtime; старые out не обновляются от изменения source.

## 5. Карта паритета до исправлений

| Возможность | Статус | Основание / регрессия |
|---|---|---|
| Одна Page для UI и browser_* | Реализовано иначе с обоснованным преимуществом | общий manager для Goose HTTP MCP; независим от native Electron CDP |
| Packaged запуск | Требует дополнительной проверки | flat lookup есть, свежий packaged не проверен текущим аудитом |
| Split/Expanded/Chat Only | Частичный паритет | BaseChat localStorage, Hub state; 1200px cap мешает wide screen |
| Resize и адаптация | Частичный паритет | mouse-only divider, нет keyboard, размеры не учитывают container |
| Инструменты: collapse/layout/width | Отсутствует | LiveBrowserPanel фиксирует w-72 независимо от ширины |
| Отдельное окно | Требует дополнительной проверки | в оригинале не обнаружено; не условие подтверждённого паритета |
| Viewport presets/custom/auto | Частичный паритет | runtime API есть, UI не предоставляет presets/custom |
| Page zoom vs preview | Частичный паритет | перенос называет DPR override page zoom; это не browser zoom оригинала |
| Native page click/type/scroll | Отсутствует | canvas overlay обрабатывает только selection |
| Navigation/back/forward/reload | Частичный паритет | API есть; ownership locking слабее оригинала |
| Hidden page continues | Частичный паритет | SSE unsubscribe сохраняет Page; MCP default зависит от active UI chat |
| Chat isolation | Частичный паритет | context изолирован, pending singleton и MCP active target могут смешивать чаты |
| DOM anchors/styles/identity | Частичный паритет | grounding/projectRegion портированы; нет source mapping и это явно диагностируется |
| Canvas/SVG fallback | Частичный паритет | диагностика есть, stale crop может ошибочно захватить новую страницу |
| Multi-rect areas | Частичный паритет | runtime поддерживает areaId, UI всегда создаёт новую область |
| Статусы/история | Частичный паритет | history хранится, UI почти не показывает; Verified можно назначить без ledger |
| Recheck source revision ledger | Отсутствует | recordCheck — запись заявления, не автоматическая проверка |
| Detect/layout candidates | Отсутствует | findings есть при selection, нет полного detect workflow |
| Reveal/crop history/color/workflow | Частичный паритет | UI нет отдельных workflow/dispute/reveal/navigation |
| Vision On/Off | Частичный паритет | provider gate заявлен; UI всегда готовит картинки, toggle отсутствует |
| Reconnect/session cleanup | Частичный паритет | EventSource reconnect, нет runtime rediscovery; title intervals и disconnected listeners не снимаются |
| UX loading/error/empty | Частичный паритет | ошибки внутри чёрного canvas, панель областей съедает preview |

## 6. План исправлений

P0: гарантировать runtime build при прямом Forge package/start, проверить fresh packaged isolated; исправить session creation race, cleanup и polling recovery; запретить stale screenshot как актуальное evidence.

P1: контейнерный resize + keyboard, инструменты collapse/resizable/layout, viewport presets и preview scale; chat-scoped pending; явные ограничения MCP active-target, verification ledger и native input до их полноценной реализации.

P2: компактные toolbar и области, светлая нейтральная поверхность, отдельная error strip с retry, история и доступная отправка области; сценарные проверки на свежей упаковке.

## 7. Ограничения исследования

Оригинал не запускался: запрещены записи в его профиль/репозиторий; изучены реальные исходники и существующие docs/img/live-browser, а не только handoff. Нативная поверхность оригинала и SSE перенос не могут считаться эквивалентными по latency/input на основании unit tests. Проверка модели, длительная память, popout и restart требуют отдельных фактических результатов ниже.


## 8. Выполненные изменения

Сохранены внешний runtime Qwen, общий BrowserManager для MCP/UI, bounded grounding и projectRegion, JSON-хранилище, SSE и polling fallback. Переписывания на WebContentsView нет: это отдельная архитектурная миграция с другим IPC и вводом.

- `build.mjs` создаёт staged `dist/live-browser/{package.json,browsers.json,dist/live-browser.js}`. Forge копирует эту директорию целиком и generateAssets запускает build даже при direct Forge package. `runtimeScriptPath` находит ожидаемый nested path, оставляет совместимость старых flat пакетов. Причина подтверждена реальным запуском: Playwright использует packageRoot = __dirname/..; отсутствие parent metadata давало Cannot find module resources/package.json. В dev ошибка скрывалась наличием live-browser/package.json.
- `BrowserManager.get` сериализует создание сессии одного чата; Page close снимает title interval и disconnected listener. Crop clip учитывает document scroll и не умножает CSS координаты второй раз на DPR/zoom. `ScreencastHub` хранит watchdog для cleanup и продолжает polling после временной ошибки capture.
- MCP требует явный conversation_id вместо выбора по текущему фокусу UI; `useChatSession` передаёт стабильный ID в контексте каждого запроса. Это защищает скрытую сессию от перенаправления действий при переключении чатов, но не является capability-based авторизацией каждого чата. Pending selection проверяет conversation ID; hub разрешён для первого сообщения нового чата.
- `RegionService.captureRegion` отклоняет stale projection, не захватывает несвязанную текущую страницу. Renderer Vision выключен по умолчанию, crop только после свежей projection; текст доступен всегда.
- `LiveBrowserPanel`/`liveBrowser.css`: collapse инструментов, side/bottom layout, responsive bottom при узкой панели, resize areas 220..520 с keyboard/pointer, сохранение выбора per-chat, независимый fit/fixed preview scale, дополнительные mobile/tablet/4K presets и custom viewport, история событий, прямой send area, добавление нескольких rect в одну area.
- `Hub`/`BaseChat`: container-based browser-first при workspace <=720, min-width/overflow constraints; split resize keyboard и cap по доступной ширине окна, без прежнего ограничения 1200. На широком экране остаётся split.
- `useLiveBrowser` очищает предыдущий кадр до paint при переключении conversation и не пишет SSE token в diagnostic log.

## 9. Проверки и оставшиеся ограничения

- TypeScript renderer и runtime: PASS. ESLint изменённых renderer/E2E файлов: PASS. Unit context/coords/pending/prompt URL: 34/34 PASS.
- Runtime smoke: 31/31 PASS после изменений MCP/crop/stale. Реальные локальный HTTP, system Chromium, SSE, MCP browser_read/state/describe/status, DOM и Canvas, persistence и два conversation. Это не модельный тест.
- Direct Forge package: PASS, offline Electron ZIP 43.4.0, output в /tmp; основные out и установленное приложение не заменялись. Первый реальный пакет выявил ошибку parent metadata; исправлен последующей полной пересборкой.
- Packaged E2E на `lad-parity-package-verified`: PASS 45.6s. Страница, реальные ненулевые canvas pixels, drag region, rename/description, pending context, tools collapse, expanded/split, keyboard resize, reload, hide/reopen и сохранённая область. Скриншот выявил clipped Hub на узком экране — исправлено после этого теста и проверяется отдельной финальной сборкой.
- GPU/MESA в окружении пишет permission error; один тестовый Electron завершился с GPU fatal при cleanup. Рабочий renderer и Chromium до этого прошли сценарий, однако это не доказательство длительной стабильности GPU.
- Модельный round-trip НЕ проверен: текущий discovery не обнаружил доступный авторизованный llama endpoint. Другой сервер/модель не запускались. UI-only конфигурация теста использует placeholder provider и не имитирует ответ модели.

Остаётся частичный паритет: настоящий browser zoom (DPR override переноса не эквивалентен оригиналу), автоматический viewport, нативный page input/IME/drag/file upload, полный reconnect после смерти runtime, восстановление URL/storage после Chromium crash, source revision verification ledger и автоматический recheck/detect/workflow/reveal. Нет длительного soak/heap исследования, dpr2 matrix, доказательства model round-trip и всех provider vision gates. Статусы Verified в переносе по-прежнему являются записью заявления, не доказательством оригинального ledger. Popout в текущем оригинале не найден, поэтому не добавлялся. Полную готовность и полный паритет объявлять нельзя.


## 10. Финальные сценарные результаты

Packaged E2E `lad-parity-package-responsive`: PASS 45.7s (46.3s total), 1600×1000 и 940×800. После narrow resize проверена правая граница панели <=941px, просмотрены wide/narrow screenshots. Сохранённые области отображаются, инструменты доступны без выхода за экран. После последнего зрителя освобождается lastFrame и state; новые regression tests проверяют transient screenshot failure и unsubscribe во время initialization. SSE error теперь повторно проверяет main runtime и запускает rediscovery/restart; это не заменяет end-to-end crash/restart тест.

Финальная сборка `/tmp/lad-parity-final/Local AI Desktop-linux-x64/local-ai-desktop`: packaged E2E PASS 49.0s (49.4s total), runtime smoke PASS 31/31. Этот артефакт включает последние reconnect/cleanup изменения. Проверены executable-пути оставшихся тестовых процессов; остатки двух ранних неудачных запусков завершены только по точным путям `/tmp/lad-parity-package/...`. Основное приложение/inference не завершались. Первые команды smoke внутри sandbox получали EPERM loopback; реальные проверки выполнены после разрешённого запуска вне сетевого sandbox. Системный pnpm отклонил engines, поэтому упаковка выполнена локальным Forge с установленным Node 24.22.1; глобальный toolchain не менялся. Инсталляторы make/deb/rpm не собирались.
