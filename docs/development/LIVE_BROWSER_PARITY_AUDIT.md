# Live Browser: аудит паритета (2026-11-08)

Разделы 11–13 — исторический срез коммита 62fdc43. Актуальные изменения и ограничения этой итерации описаны в разделах 14–16; они заменяют прежние статусы отсутствующих ledger, reselect и Vision revocation. Разделы 1–10 фиксируют предыдущий аудит и промежуточную SSE-реализацию; их ограничения не являются автоматически состоянием нового кода.

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


## 11. Live Browser 2: повторное исследование и новая архитектура

Повторное исследование оригинала выполнено до этой реализации и записано в [LIVE_BROWSER_2_DESIGN.md](LIVE_BROWSER_2_DESIGN.md). Существенная находка: текущий оригинал уже использует **WebContentsView**, настоящий `webContents.setZoomFactor`, независимый display scale и CSS pan. Сохранение canvas как основной поверхности не могло обеспечить его ввод и zoom. Исходный репозиторий и его профиль не запускались и не изменялись.

`ui/desktop/src/nativeBrowserHost.ts:NativeBrowserHost` теперь создаёт sandboxed WebContentsView с отдельной persistent Electron session на conversation и прикрепляет её к окну владельца. Изолированные HTTP/WebSocket endpoints на loopback требуют runtime bearer. CDP bridge разрешает один target и его дочерние sessions, запрещает browser-wide target escape. Page UI и Page Goose совпадают; новый Chromium для native-сессии не запускается. `BrowserManager.createSession` подключается к этому target, не создавая другую Page/CDPSession. В native-режиме `ScreencastHub` не производит JPEG; SSE передаёт состояние. Внешний Node runtime, Goose MCP, bounded grounding/projectRegion и JSON area store Qwen сохранены. Standalone системный Chromium/SSE fallback также сохранён.

Независимые пространства: physical viewport → CSS viewport через настоящий browser zoom; display DPR берётся с Electron display; preview fit/fixed влияет только на presentation. Pan хранится в CSS px, с ограничением видимой поверхности, средней кнопкой/Hand mode и колесом в Hand mode. Hand использует собственный прозрачный input shield с DOM wheel deltas: Electron before-mouse-event не отдавал необходимые deltas. Shield общий с agent ownership, без app preload/Node. В Interact колесо остаётся у сайта. `useNativeBrowserView` передаёт bounds в main, hide удаляет bounds без закрытия Page. Ownership shield блокирует пользовательский ввод при работе агента; передача управления освобождает отслеженные user keys/buttons и снимает selection overlay. Hidden sessions продолжают работу, MCP всегда требует явный conversation_id.

Сбой runtime сохраняет native Page. При отключении CDP reset debugger-соединения нужен потому, что повторный `Runtime.enable` без reset не отдавал execution contexts новому Playwright. Эта причина была воспроизведена: сохранённый DOM ещё читался тестовым main API, но UI оставался пустым. Теперь SSE дожидается reattach до объявления Connected. Сохранённые URL/partition mappings позволяют восстановить страницу и cookies после закрытия приложения; полный Chromium crash matrix пока не проверен.

### Контекст и проект

`attachments.ts`, `PendingBrowserAttachments.tsx`, `UserMessage.tsx`: пользователь видит обычный текст и компактную раскрываемую карточку области с названием страницы, количеством регионов, Vision и проектом. Draft можно удалить, несколько областей допускаются, очередь разделена по conversation. Технический payload не вставляется в composer.

`crates/goose/src/acp/server/live_browser.rs:prepare`: валидирует typed payload и UUID reference, сохраняет immutable registry в `session.extension_data` (`live_browser.v1`), раскрывает только явно приложенные IDs в assistant-only Content. Visible card использует совместимый с ACP text reference с `audience: user`; технический контекст — `audience: assistant`. Это backend projection, не CSS-подмена истории. Streaming (`server.rs:handle_message_content`) и replay фильтруют audience; edit/resend сохраняет reference и разрешает её через registry после truncate. Registry сохраняется при fork и не выдаёт ID чужому чату; параллельные merges сериализованы. Генерация заголовка исключает reference. Payload ограничен 8 вложениями на запрос, 128 записями/32MB на registry, 24KB текста и 3 ограниченными изображениями на вложение. Достижение лимита даёт явную ошибку, не молчаливое удаление старых evidence.

`DirSwitcher` → `acpUpdateWorkingDir` → `manage_sessions.rs:on_update_working_dir` действительно меняет working_dir Goose и сохраняет канонический выбранный каталог с provenance `explicit-directory-selection` (`live_browser_project.v1`). Hub выполняет эту привязку перед первым prompt; при создании чата передаёт свою Page и области новой conversation. Ошибка adopt сохраняет draft и не прикрепляет область к другой Page. Backend добавляет conversation ID и project scope также к обычным запросам без области. Default cwd не объявляется выбранным проектом, путь не выводится из localhost. Корни выбранного Project source добавляются отдельно, с primary/secondary/active. Goose имеет один project_id; это список корней, а не новая система нескольких независимых project entities. Никакие metadata не расширяют разрешения filesystem: инструменты используют реальную working_dir с существующими Goose approvals/mode. В Chat mode редактирование файлов не обещается.

Vision Off удаляет изображения из attachment registry и запрещает image results `browser_screenshot`/`browser_describe_area`. UI crop готовится после свежей projection, stale evidence не подменяется снимком другой страницы. Vision On — явное разрешение пользователя для этого чата; качество поддержки конкретным provider дополнительно зависит от Goose.

### Обновлённая карта

| Возможность | Текущий статус | Реализация / граница |
|---|---|---|
| Одна native Page для UI/Goose | Полный паритет | NativeBrowserHost + ограниченный CDP; реальный MCP click виден в native DOM |
| Packaged runtime и Node | Полный паритет | staged resources/live-browser, отдельный Node 24 с LICENSE; проверен реальный executable |
| Настоящий browser zoom | Полный паритет в Electron | setZoomFactor; CSS innerWidth меняется независимо от preview/DPR; standalone legacy approximation остаётся fallback |
| Auto/presets/custom viewport, Fit/fixed preview | Полный паритет основных controls | отдельные значения, main bounds/Emulation, React controls; нет исходного resize-grabber страницы |
| Split/Expanded/Chat Only | Полный паритет | сохраняемая доля 25..75%, container resize, narrow browser-first |
| Split/inspector keyboard resize | Полный паритет | focusable separators и стрелки; pointer resize также реализован |
| Areas panel workspace-first | Реализовано иначе с обоснованным преимуществом | закрыта по умолчанию; компактный inspector, side/bottom, resize, поиск, один editor вместо раскрытия всех областей |
| Pan/колесо | Частичный паритет | middle drag/Hand drag и Hand wheel, reset/persistence; исходные pan-pad/scrollbars не переносились |
| Native input/IME/drag/upload | Частичный паритет / дополнительные проверки | native surface, реальные click и IME composition проверены; OS file chooser и разнообразные drag/drop/IME системы не прошли полную матрицу |
| Скрытая Page/явный MCP target | Полный паритет основных гарантий | hide не закрывает; explicit conversation_id, owner check; второй target проверен отдельно |
| Runtime crash recovery | Полный паритет проверенного сценария | SIGKILL только тестового Node, повторный attach, DOM/input/area сохраняются и selection создаётся заново |
| Chromium/app restart recovery | Требует дополнительной проверки | URL + persistent partition mappings реализованы; возврат полного in-memory SPA state после Chromium crash не обещается |
| DOM anchors, CSS, geometry, identity | Частичный паритет | bounded grounding Qwen сохранён; browser evidence не выдаётся за доказанный source mapping |
| Canvas/SVG/WebGL fallback | Частичный паритет | общая canvas/SVG диагностика без anchors; реальный canvas тест, отдельного WebGL hardware matrix нет |
| Несколько regions в area | Частичный паритет | add region/remove/rename/description/status/history; нет полноценного reselect существующего region с сохранением всей исходной истории |
| Compact model attachments | Реализовано иначе с обоснованным преимуществом | typed backend registry + audience projection, чистый user transcript, retry/fork изолированы |
| Explicit project root → model | Полный паритет проверенного data path | нормальный picker React/Vite root → реальный cwd Goose → backend scope → provider request |
| Автономное «Исправь это» | Требует дополнительной проверки | данные и MCP проверены, но доступной Qwen нет; реальное нахождение/изменение исходника моделью НЕ подтверждено |
| Recheck | Частичный паритет | повторная projection + history; кнопка честно называется Recheck binding |
| Source revision verification ledger | Отсутствует | Verified и заявленный verified запрещены без доказательств; это предохранитель, не замена ledger |
| Detect | Частичный паритет | ограниченные DOM overflow candidates; не полный исходный detector/workflow |
| Reveal/evidence history | Частичный паритет | reveal текущего anchor/rect и events/checks; нет полного журнала исторических crops/revisions, dispute/deleted references/color workflow |
| Отдельное browser window | Требует дополнительной проверки как требование | в изученном оригинале popout не найден; не добавлялся |

## 12. Проверки Live Browser 2

Постоянный свежий packaged executable: `.local-work/live-browser2-release-candidate/Local AI Desktop-linux-x64/Local AI Desktop`. Сборка содержит последний Rust backend, native main/preload/renderer и staged Node runtime; SHA256 backend сверена с `target/release/goose`. Основная установленная версия и Ubuntu Desktop Entry в этой итерации не заменялись.

- Rust attachment tests: 3 PASS: reload/truncate/fork, cross-session refusal, default cwd не project, explicit directory, Vision Off, immutable IDs, concurrent merges. Session naming tests: 2 PASS. `cargo fmt --all --check` и `cargo clippy -p goose --lib --no-default-features -- -D warnings`: PASS.
- Renderer/runtime TypeScript и targeted ESLint: PASS. Frontend/Node tests: 39 PASS.
- Standalone runtime smoke: **32 PASS**. Старое ожидание image при Vision Off сначала дало 30/31; тест исправлен на проверку Off и явного On, ограничение не удалялось ради зелёного результата.
- Свежий packaged Electron: **4 PASS, 1 SKIP** за 54.1s (реальная модель). React/Vite fixture использует настоящий directory picker, регион, короткий запрос «Исправь это», backend/provider wire capture, чистую историю и edit/resend. Мок возвращает фиксированный ответ, не моделирует Qwen и не редактирует исходники.
- Дополнительно: уникальные Hub IDs и разные Page двух окон; закрытие второго окна без падения main; перенос существующей Page в первый чат без области; hidden viewport и свежесть screenshot после изменения DOM. Найден и исправлен cleanup после уничтожения owner (`BrowserWindow.fromWebContents`), который вызывал необработанное исключение main.
- Native E2E проверяет настоящий zoom по innerWidth, Unicode/IME composition, MCP click на той же Page, второй hidden chat, Canvas fallback, отказ Verified, Vision Off tool result, SIGKILL собственного runtime (путь профиля проверяется через /proc), возврат UI URL/native mode и новое выделение после reattach, narrow bounds, Expanded, hide/reopen, error strip.
- Визуально просмотрены полные X11 окна 940×800, 1600×1000, 2560×1300, Expanded, inspector и display controls. Реальные X11 pointer tests дополнительно выявили перекрытие split separator native view и прерывание middle drag из-за React effect cleanup при каждом pan; исправлены hit area и раздельный lifecycle/settings update. Первый стенд ошибочно менял только renderer viewport; исправлен `resizeNativeWindow`, проверяются реальные размеры BrowserWindow. `native-window-shot.ts` захватывает WebContentsView, а не только renderer. Снимки/логи/пакет остаются ignored local artifacts.
- Искусственное падение Node даёт ожидаемый ERR_INCOMPLETE_CHUNKED_ENCODING; запрещённый file: даёт ожидаемую навигационную ошибку. В окружении были MESA/GPU сообщения при cleanup ранних запусков; долговременная GPU стабильность этим не доказана. Тестовые процессы завершаются по своей process group, без широкого pkill.

## 13. Что необходимо доделать до заявления полного паритета

1. Реальный Qwen end-to-end: выбранный безопасный проект → область → «Исправь это» → source discovery/edit через разрешённые инструменты → проверка в той же Page. Endpoint не найден, новая модель не загружалась. Нельзя выдавать protocol fixture за этот результат.
2. Source-revision ledger, достоверное автоматическое подтверждение fix, historical crop/evidence/revision workflow, replace-region и полный detect/recheck/dispute UI.
3. Длительный soak/heap audit, Chromium crash/restart с cookies и несколькими SPA, DPI 2/display switching, OS file upload и реальные IME/drag сценарии разных платформ.
4. Vision Off проверен для новых вложений и текущих MCP images. Ранее разрешённые Vision On снимки сохраняются в истории; ретроактивный отзыв изображений при смене режима не реализован. Compaction реально работающего agent loop и разные model/provider vision gates: persistence primitives проверены, полная матрица не проверена. Также нужны проверки переключения project_id после explicit directory и повторного использования старых вложений при смене project scope.
5. В native режиме перекрывающий поверхность renderer menu временно скрывает native view; это безопасный обход native z-order, но возможна дальнейшая UX-доработка. Старые технические пользовательские сообщения не переписывались: сохранность истории важнее неоднозначной миграции.

Полный паритет и завершённый автономный workflow не объявляются. Эта итерация даёт проверяемую нативную основу и новую UX/attachment архитектуру, а не доказательство всех возможностей исходного visual debugger.

## 14. Continued Visual Debugging: original contracts and implementation

The read-only original was inspected again: `src/main/services/visual-debugging.ts:validatedDocument/command`, `src/main/services/visual-workflow.ts:provesOriginalRegions`, `src/main/web/project-browser.ts:visualRecheck`, and `src/main/web/browser-scenario-runner.ts:observe(text_fit)`. Important contracts: workflow completion is not verification; original URL/viewport/unique DOM identity must be checked; clipping uses rendered text ranges rather than text presence; source revisions must stay fresh; unsupported Canvas/hidden/private targets remain inconclusive.

Implemented on the existing WCV + Node/MCP + Rust architecture:

- `acp/server/live_browser.rs:source_revision/hash_sources` obtains the **explicitly selected session root**, hashes bounded source inventory and returns hashes, not file contents. No caller-controlled filesystem path. Symlinks, hidden/dependency/build trees are excluded; limits are 10,000 entries, 2,000 source files, 4 MB/file and 32 MB total. Unsupported/oversized projects fail closed. `custom_dispatch.rs` exposes a private product ACP method; `AppInner`/preload/`NativeBrowserHost.sourceRevision` bridge only the owning conversation to it.
- `RegionService.recheck`, `verification.ts:textFit`, `BrowserManager.verificationViewport`: fresh original-page load, exact original CSS viewport, original unique anchor/identity, bounded rendered text range measurement, runtime errors, before/after source fingerprint. Loaded inline source-map contents must match selected-project hashes to certify a pass. This associates observed browser resources with a revision; it does not assert an exact React-to-pixel source mapping. Missing source association means Not Verified. Cache is disabled only for the verification load via a temporary route; initial testing caught Vite 304 responses omitting useful source evidence. Preview settings and ownership restore in finally.
- A bounded per-area ledger stores exact region/snapshot/URL/viewport/selector, expected/observed values, source fingerprint, served sources, timestamp and errors. Full receipts are local evidence files. Status Verified is produced by this runtime measurement, never `browser_check_area` or an assistant claim. Original text-fit candidates across one to six same-route/same-viewport regions are supported; arbitrary visual intent/custom assertion matrices remain partial.
- `RegionService.list` downgrades Verified when project or source fingerprint changes. Selection mutations/dispute also invalidate it. Existing areas remain compatible; legacy Verified claims remain visibly unproven.
- Historical selection/reselection/recheck anchors, geometry and crops are retained. Twenty observations per region retain the original plus recent observations; fifty ledger records per area; crop/receipt storage is limited to 32 MB/conversation. History image bytes are fetched explicitly for the inspector, not broadcast in SSE or automatically sent to a model. A quota/capture failure is diagnostic, never fake evidence.
- Reselection retains region ID and historical evidence; adding/removing several regions continues to work. Reveal is distinct from explicitly opening the saved page. Workflow active/completed/disputed is distinct from Verified. Inspector shows evidence, saved crops and ledger. Automatic overflow detection deduplicates existing targets and retains candidate semantics.
- Per-conversation reentrant transactions serialize async evidence/area mutations so capture/recheck cannot overwrite a concurrent rename or workflow update. Different conversations remain independent. SSE no longer retains empty subscriber sets or reads state for absent viewers.
- A new snapshot suffix preserves the original document-time prefix used by Canvas/SVG stale checks. A preliminary random replacement broke Vision On canvas capture; standalone smoke caught it and the document-prefix contract was restored.

## 15. Context safety, inference and acceptance boundaries

`agents/browser_vision.rs` projects **current** Vision policy at request time through `reply_parts::stream_response_from_provider`, without deleting persisted messages or registry snapshots. It strips historical browser attachment pixels and marked browser MCP images (including when a tool request has been compacted away); ordinary uploaded images are retained. Legacy browser evidence is recognized separately. The model receives an explicit current-Off note. This cannot revoke an in-flight/already delivered request; full live-provider/compaction matrices still require acceptance.

`acp/prompt.ts` supplies current workspace policy for normal prompts and steering. New browser images carry provenance metadata. Saved attachment project roots are compared to current authoritative scope; a stale attachment cannot silently become another selected project. A rejected prompt clears the active-run marker so correction/retry is possible. The UI now supplies the actual selected root to its bounded evidence builder as well as relying on backend scope.

Real inference investigation and current Qwen acceptance are recorded in [LIVE_BROWSER_QWEN_ACCEPTANCE.md](LIVE_BROWSER_QWEN_ACCEPTANCE.md). The primary configured gateway was found, but refused TCP connections on the host, with no primary inference processes resident. No model was loaded by the task. Scripted provider tests verify protocol, ledger and Vision projection only.

Safe Ubuntu update: `scripts/dev/activate-packaged-build.sh` validates a permanent side-by-side package and can atomically select it for the next `launch-goose-dev.sh` invocation. It does not stop anything or replace `out/`, profiles, chats or GGUF. The relevant menu entry is `~/.local/share/applications/local-ai-desktop-goose-dev.desktop`; other `/opt/local-ai-desktop` entries are separate installations and were not modified. The default remains the existing out until explicit activation.

Final test counts/build/hash and remaining acceptance gaps are maintained in the handoff after the final packaged run. Full parity is not declared: real Qwen autonomous repair, general visual criteria beyond original text fitting, full historical/deleted-reference workflow, long-duration heap/GPU stability, DPI/display matrix and full real-agent fork/compaction/provider coverage remain separate work.


## 16. Acceptance update — 2026-11-09

| Capability | Current status | Evidence / boundary |
|---|---|---|
| Source revision ledger and recheck | Partial parity | Trusted selected-root hashes, fresh original Page/viewport/anchor, rendered text fitting, loaded-source-map association, immutable historical receipts. General visual criteria are not certified. |
| Evidence/history/reselection | Partial parity | Original identity and capture retained, bounded history/crops, explicit inspector retrieval, original region ID preserved; full deleted-reference/planner workflow remains incomplete. |
| Verified safety | Implemented | Source/project changes, selection mutations, changed acceptance description, explicit status changes and disputes invalidate current proof; historical ledger remains. Workflow completion cannot certify a fix. Criterion is explicitly text_fit. |
| Vision Off on later requests | Implemented for tested paths | Historical browser pixels removed at provider projection, regular uploads preserved, history/registry unmodified. Streaming already sent/in-flight cannot be revoked; full real-provider compaction matrix unconfirmed. |
| Native renderer crash | Tested scenario | Page.crash recovery, URL/cookies/localStorage, same-chat ownership. Entire application restart and arbitrary SPA in-memory restoration are separate. |
| Native input | Partial parity | Actual IME composition, OS-pointer drag/drop, own-file chooser approval and contents; full graphical chooser/DPI/platform matrix unconfirmed. |
| Explicit project → model | Tested protocol | DirSwitcher, authoritative ACP scope, source hashes and provider request. Load-response browserProjectRoot restored in renderer without inferring project from cwd. |
| Real Qwen autonomous repair | Requires acceptance | Selected managed gateway found; host TCP unavailable, no resident matching model. No scripted completion counts as a Qwen pass. |
| Long-term stability | Partial check | 120-second/96-cycle resource sample is a short regression soak, not proof of absence of leaks over hours. |

Final package and concrete test results are recorded in the current handoff. Native-window screenshots cover wide/medium/narrow/expanded, selected/error/empty and explicit historical evidence. Technical JSON is available only after explicitly opening the evidence inspector; compact chat attachments remain compact.

During final regression a pre-existing E2E selector using last summary matched a newly nested hidden history entry. It was replaced with the explicit Evidence & history control; no forced click was introduced. A unit fixture initially used the unsupported area status Failed (a verification outcome); corrected to Unresolved. These failed preliminary runs are not reported as successful final tests.

Final packaged regression: 6 PASS / 2 model-dependent SKIP (1.2m); isolated gio Desktop Entry navigation/selection/attachment: 1 PASS. Targeted frontend/ACP: 51 PASS; Rust registry/revision 5, Vision 2, metadata 1 PASS; standalone smoke 32 PASS. Latest typechecks, targeted lint, fmt and clippy passed. The initial cached-scope label failure was fixed by publishing the acknowledged Hub scope into the session store, not by substituting cwd. No production activation or real-model PASS is implied.


Ubuntu launch follow-up (2026-11-10): the user's permanent Desktop Entry was inspected and run twice via `gio launch`. Both attempts started the selected package and reached React/Live Browser runtime readiness; the first QA-owned instance closed cleanly before the second. No incorrect pointer, missing file, permission issue or Electron startup error reproduced. `scripts/dev/test-launch-entry.py` guards Desktop Entry wiring and package selection. This records the evidence without inventing a root cause for the earlier unobserved failure.
