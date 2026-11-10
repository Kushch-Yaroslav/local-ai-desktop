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
5. Старые технические пользовательские сообщения не переписывались: сохранность истории важнее неоднозначной миграции. Исправления текущей панели и меню отражены в разделе 20 ниже.

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


GNOME menu issue resolved at the actual application ID: the visible canonical `local-ai-desktop.desktop` had remained system-bound to `/opt/local-ai-desktop/local-ai-desktop`; activating the app changed only the Goose Dev ID. A user override now points the canonical ID to the active-build launcher, the old user aliases and redundant Goose Dev ID are backed up and hidden, and favorites target the canonical ID. `gtk-launch local-ai-desktop` started the active package twice with clean targeted close between runs. Physical app-grid click and a fresh login were unavailable for automation and are called out in the handoff.


## 17. MTP On discovery follow-up — 2026-11-10

This is an inference/runtime acceptance update; it does not upgrade unverified Live Browser autonomous repair to PASS. See [MTP_CONTEXT_DISCOVERY.md](MTP_CONTEXT_DISCOVERY.md) for the complete source audit and measured evidence.

Discovery now calibrates actual MTP runtime from 4K, distinguishes fixed speculative/recurrent state through a second measured point, requires positive drafted tokens, retains independently measured FP16/Q8 and honors explicit reserves. Settings expose slots, independent draft KV and draft microbatch. The explicit one-slot/one-draft memory preset requires review/save and preserves MTP/placement. Persistence policy v2 accepts 4K/8K and separates changed reserves/placement.

Real Qwen3.6-35B RTX3090 tests confirm full-GPU preset 45,056 FP16 / 69,632 Q8; explicit CPU experts for first one/two blocks confirm 57,344/90,112 and 81,920/118,784 respectively. Ordinary activation generated at each returned size with actual draft acceptance. Fresh packaged Electron's UI save → actual bundled runtime discovery → ordinary max-context generation PASS, native-window screenshot checked. 100 targeted regressions PASS; TSC/targeted lint/EN extraction/RU placeholders PASS; all-locale completeness remains FAIL. Tests used isolated profiles and no concurrent model; primary application and original repository remained untouched.

Candidate `.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64` is checked but not activated. Exact-path AppArmor permission and explicit safe activation are required before the existing Dock launcher uses it. No claim is made about filled long-context quality, exhaustive CPU tradeoffs or a new real Qwen3.8-27B test.


## 18. Ordinary-profile MTP diagnostic quota — 2026-11-10

See [MTP_DISCOVERY_LOG_REGRESSION.md](MTP_DISCOVERY_LOG_REGRESSION.md). The current-child diagnostic budget incorrectly included the append log's entire historical size, starving later probes. This is fixed without relaxing evidence requirements. The old package reproduced failure with real MTP generation; the fixed saturated-log packaged test passed. Actual saved ordinary profile and permanent Desktop Entry → Session settings → search → apply each result → ordinary generation PASS: 45,056 FP16 / 69,632 Q8, positive drafted/accepted counts. Profile registry unchanged, original selection restored, results persisted. 74 targeted tests, TSC/targeted lint PASS.

Fresh candidate `.local-work/mtp-log-regression-checked/Local AI Desktop-linux-x64`; already activated package `.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64` received the identical fixed asar atomically while no main app was running. Runtime/resources, pointer, AppArmor and canonical Desktop Entry were preserved. No reactivation needed. This follow-up does not certify arbitrary long-context quality, physical Dock interaction or full Live Browser autonomous-repair parity.


## 19. Repeatable unloaded discovery / CUDA graph OOM — 2026-11-10

[Detailed diagnosis and evidence](MTP_DISCOVERY_REPEATABILITY.md). User's 15:51 Q8 94,208 probe crashed in cudaGraphInstantiate with `CUDA error: out of memory`. The classifier missed that spelling and stopped the entire search; generic UI masked the cause. It now treats this precise OOM as a boundary, drains the owned process, keeps independent probe logs/run receipts, and preserves primary plus restore failures. UI exposes stage/context/KV, actual recovery and older-results notice.

Six consecutive actual ordinary-profile UI searches in one Electron instance PASS, including cold unloaded, saved results, repeated unloaded, loaded after generation with restored effective settings, normal stop and re-search. All return 45,056 FP16 / 69,632 Q8, MTP On. Four real Q8 OOM boundaries at 86,016 were handled successfully. Subsequent reopened UI selection/generation at both modes PASS. Profile registry unchanged, original selection restored. 112 targeted tests, TSC/targeted lint/EN extraction/RU validation PASS. Existing activated package already updated safely; fresh candidate `.local-work/mtp-repeatability-final/Local AI Desktop-linux-x64`. No reactivation needed. This does not assert all Live Browser parity or filled long-context quality.


## 20. Live Browser 3 visible regions, findings and inspector UX — 2026-11-10

### Причины и исправления

- Выделение сохраняло DOM-evidence и попадало в инспектор, но нативный `WebContentsView` не показывал постоянную рамку. Renderer selection outline был только transient-инструментом. E2E также нашёл ошибку формы данных: painter передавал wrapper `{ id, areaId, ..., region }` в `projectRegion`, который ожидает `LadRegion`; поэтому выбранная область не проецировалась на native Page. `runtime/grounding.ts:paintRegions` теперь проецирует `item.region` и рисует закрытый Shadow DOM overlay непосредственно в той же Playwright Page, которую показывают WebContentsView и использует Goose. Его фон прозрачен для мыши; кликабельны только небольшие подписи. Пересчёт выполняется при scroll/resize/DOM mutation/ResizeObserver и на время CSS motion, а не на каждом постоянном кадре. DOM regions следуют за однозначным живым anchor. При URL/identity/selector invalidation отображается stale badge; screenshot-only Canvas/SVG projection остаётся допустимым только для исходных документа, viewport и DPR.
- Detected overflow results сохраняются как `LadArea.origin='detected'` и остаются **potential candidates**, с DOM-facts и номерами в инспекторе; это не `Verified`. `RegionService.detect/reveal` возвращают идентификаторы, открывают/прокручивают связанный элемент и не дублируют совпадающие selectors при повторном скане. Overlay передаёт клики по маркерам в инспектор. Page-side recheck сверяет clipping/overflow/overlap категории после DOM-изменений, сохраняет `finding.state` (`current`/`stale`) в конкретной области и обновляет инспектор. Потерянный якорь показывает stale binding, а исчезнувшее измеряемое условие помечается «Больше не обнаруживается · перепроверьте». Неподдерживаемые стилистические/семантические предположения не превращаются в доказанные дефекты.
- Причиной исчезавшей страницы была логика `useNativeBrowserView`: при пересечении с любым renderer `[role=menu/listbox/dialog]` она передавала `null` bounds. Настройка масштаба открывала Radix portal и на время меню скрывала WCV. `LiveBrowserPanel:Choice` теперь использует inline keyboard menu (arrows/Home/End/Escape, checked value) вне native поверхности; bounds продолжают обновляться, страница не скрывается и Page/viewport/pan не переинициализируются. `useNativeBrowserView` резервирует временное перекрытие только для настоящих `aria-modal=true`/открытого native dialog.
- Описание области называется «Описание проблемы / что нужно исправить» с подсказкой о передаче AI. Текст сохраняется в правильной области, включается как отдельное description-поле typed browser attachment и добавляется в provider context в `crates/goose/src/acp/server/live_browser.rs:attachment_context`; повторная передача description не дублируется в model context, immutable attachment id нельзя переназначить другой области. Composer и история показывают компактное вложение с меткой «Есть описание», не технический внутренний prompt.
- `RegionService.removeAllAreas` — сериализованная операция scoped к conversation: чистит области/регионы текущего чата, связанные evidence files и подсветку; frontend очищает только pending attachment этого чата. Подтверждение показывает количество и предупреждает об истории/crops без Undo (удаление истории необратимо). Пустой inspector показывает «+ Выделить область», сразу включает Selection только при открытой Page; без Page фокусирует навигацию.
- Ключевые static и inline Live Browser строки используют `react-intl`; новые ключи присутствуют во всех каталогах с English fallback, RU labels/status/evidence локализованы. Старые сохранённые имена областей и enum/API значения не переписываются.

### Изменённые контракты и файлы

`ui/desktop/live-browser/runtime/{grounding.ts,regions.ts,control.ts,store.ts}`, `shared/{types.ts,api.ts}`, `src/components/liveBrowser/{LiveBrowserPanel.tsx,useNativeBrowserView.ts,liveBrowserClient.ts,useLiveBrowser.ts,liveBrowser.css,i18n.ts,attachments.ts,PendingBrowserAttachments.tsx}`, `src/components/UserMessage.tsx`, `crates/goose/src/acp/server/live_browser.rs`. Regression tests: `transactions.test.ts`, `attachments.test.ts`, `tests/e2e/live-browser2.spec.ts`, `tests/e2e/live-browser-context.spec.ts`.

### Проверки

В процессе проверки самого packaged Chromium crash E2E воспроизвёл дополнительную ошибку: `bindRegionSelection` оставлял отклонённую `ready` Promise в `WeakMap`, когда Chromium уничтожил execution context. Все последующие попытки рисования повторяли старую ошибку, `/control/display` возвращал 500, а UI продолжал показывать временное сообщение после восстановления страницы. `RegionService` теперь удаляет failed binding, ограниченно повторяет paint после transient navigation/target-crash и не превращает ожидаемый переход context в постоянную ошибку. Overlay выставляет количество stale regions для диагностики; после Chromium crash тест подтверждает два сохранённых региона: один с валидным anchor и один помечен stale, а не нарисован по старым координатам.

Свежая side-by-side сборка: `/home/yaroslav/.local/opt/local-ai-desktop-goose-dev/packages/live-browser3-ux-rc5/local-ai-desktop` (resources включают Node runtime и `live-browser/dist/live-browser.js`). Пакет перенесён на постоянный системный раздел без копирования профиля/чата; активация не выполнялась. `--check` проходит с реальным lowercase executable, выданным Forge. Активационные скрипты принимают оба поддерживаемых имени приложения (`Local AI Desktop` и `local-ai-desktop`), не меняя user data location. Packaged Electron до переноса запущен изолированным профилем; те же байты подтверждены hashes после переноса. Реальные screenshots всего X11 окна, включая WebContentsView: `.local-work/live-browser3-ux-rc5/screenshots/` (`native-menu-open`, `native-manual-region`, `native-findings-marked`, `native-findings-stale`, `native-wide`, `native-expanded`, `native-narrow`, `native-ru-region` и состояния empty/error/selected). Визуально проверены 940×800, 1600×1000, 2560×1300, Expanded, раскрытое page-zoom menu, inspector, selection/finding outlines и RU labels. Страница остаётся видна под меню.

- Native packaged E2E `live-browser2.spec.ts`: **1 PASS** (~25 s). Проверены inline zoom menu без скрытия страницы и выбор масштаба клавиатурой ArrowDown/Enter, selection frame/label, hover/select/reveal, три уникальных candidate-элемента без повторных областей, актуальное/устаревшее finding, atomic delete-all текущего conversation, CTA пустого inspector, viewport/page zoom/preview scale/pan, настоящий CDP click и IME, MCP на той же Page, скрытая панель, restart принадлежащего только тесту Node runtime, Chromium renderer crash/reload, сохранение cookie/storage, reconnect и region re-projection.
- Provider/context packaged E2E `live-browser-context.spec.ts`: **3 PASS** (~27 s). Fixture React/Vite выбран через штатный picker. Тест проверяет, что точный выбранный root, region DOM selector/evidence и описание идут в provider request; обычный текст/история остаются компактными; retry/regenerate сохраняет project и region context; Vision Off удаляет browser crops из следующих запросов. Это scripted provider: тест **не** запускает Qwen, не делает tool-call и не исправляет файлы.
- RU packaged E2E `live-browser-i18n.spec.ts`: **1 PASS** (~8 s), включая состояние без страницы, действие «Выделить область», локализованное имя/статус и нативный overlay.
- Vitest live-browser suite: **40/40 PASS**; renderer и runtime TypeScript: PASS; targeted ESLint изменённых TS/TSX app/E2E файлов: PASS; `cargo fmt --all --check`: PASS; `cargo test -p goose --lib acp::server::live_browser --no-default-features`: **6 PASS**; `i18n-check`, `i18n-compile`, `i18n-validate-locale ru`: PASS (RU 2,121 messages).
- Crash test первоначально выявил stuck binding и сообщение `/control/display` 500. После исправления в финальном прогоне этих ошибок нет; ожидаемая `ERR_INCOMPLETE_CHUNKED_ENCODING` относится к намеренному SIGKILL только тестового Node runtime, а `protocol-not-allowed (file)` — отдельная проверка запрета file URL. Системное приложение, основная Qwen/proxy, её настройки, установленный Desktop Entry и пользовательский профиль не запускались/не менялись.

Не подтверждены реальный Qwen «Исправь это» с автоматическим исследованием и изменением проекта, долгий soak/heap profile именно этой RC, OS chooser/file upload и полная матрица DPI/дисплеев. Выдача `Verified` для произвольных визуальных критериев, полная история удалённых ссылок/evidence и весь оригинальный workflow остаются частичными согласно разделам 11–16. Полный функциональный паритет не заявляется. См. обновлённый [LIVE_BROWSER_HANDOFF.md](LIVE_BROWSER_HANDOFF.md) для сборки, hashes и точных команд безопасного переключения.

## 21. Side-by-side candidate path validation — 2026-11-10

The checked Forge package is preserved at `/home/yaroslav/.local/opt/local-ai-desktop-goose-dev/packages/live-browser3-ux-rc5/`, outside `/tmp`, the full DATA partition and the symlinked Goose profile. Inspection found its real executable is `local-ai-desktop`; previous activation helpers only accepted `Local AI Desktop`, so the first side-by-side `--check` correctly refused it. Activation, launcher, menu validator and exact AppArmor attachment now accept either supported executable spelling while still restricting candidates to the repository QA directory or the dedicated per-user package store. New regression tests confirm `--check` and launch selection for the persistent lowercase Forge package. `--check` passes against RC5. No selection pointer, AppArmor rule, Desktop Entry, active process or profile was changed; activation remains a deliberate later user action. See the current handoff for safe commands and package hashes.

## 22. Native dropdowns, bounded findings and description-only tasks — 2026-11-10

The previous inline Choice expanded the settings/inspector flex layout. `LiveBrowserPanel.Choice` now invokes a sender-validated, bounded `live-browser:choice` IPC in `desktopMain.ts` through the typed preload API. Electron Menu radio items compose above the WebContentsView; no second Page, null bounds, renderer portal or viewport resize is involved. OS menus provide outside-click dismissal and keyboard navigation; trigger focus is restored after dismissal. Native E2E uses XTest on a uniquely identified, active isolated window and root-window pixel capture, including the separate menu window.

`liveBrowser.css` bounds the findings list independently from the selected editor, contains wheel overscroll, clamps row summaries, and reduces the duplicate area list to a bounded 32px selector when a detected finding is selected. The selected finding's diagnostic details are collapsed by default. The scan remains bounded (4000 elements, now at most 32 candidates rather than 12), permitting a real 15-finding acceptance scenario. Neither source-revision verification nor candidate status semantics changed.

`pendingContext.pendingDescription` trims and joins descriptions only from the requested conversation. ChatInput subscribes to pending draft changes; both Enter validation and Send validation accept a meaningful description. Hub allows that draft to create/adopt a chat. `useChatSession` persists description-only user prose and the existing typed attachment references together. The synthesized visible prose has user audience, so provider projection receives the description once from the durable attachment registry rather than twice. Composer text plus description continues through the normal path. No Rust registry schema, project permission, Vision policy or inference implementation changed.

Acceptance: targeted pending/attachment/transaction tests 12 PASS; TypeScript and targeted ESLint PASS. Packaged scripted-provider E2E confirms blank composer dispatch, exactly one description in the first provider user payload, selected project root and DOM evidence, compact history, edit/resend, verification/evidence workflow, and Vision Off historical-image suppression. Matrix tests use 0/1/3/7/15 findings at 1600x1000, 1280x720, 1100x650 and 940x600 with native screenshots, scroll-to-last-row and selected detail checks. Native browser E2E checks identical settings bounds with menu open, visible page, actual OS key selection, independent zoom, lifecycle and isolation. The final rerun/install status is recorded at the start of HANDOFF.

Limits: no loaded llama-server was present, so this iteration does not claim a new real-Qwen generation test. Multiple-description trimming/isolation is unit-covered; this iteration has not added a full multi-area provider or explicit Chat/Agent mode matrix, nor a new process-restart persistence/compaction test. Existing durable registry/vision mechanisms remain in use. Physical Dock click and GNOME re-login require user acceptance.

## 23. Final visual acceptance and activation — 2026-11-11

After user-authorized AppArmor installation, final native screenshots were repeated without the authentication dialog. The first rerun exposed that hiding the area list removed hover/access to other saved areas. Commit `6449469` retains a compact 32px scrollable selector; the rebuilt package passed all 6 native/inspector scenarios, including all 20 findings-count/window-size combinations and the saved-area hover regression. Representative root-window screenshots are retained in `.local-work/live-browser-refinement-evidence/`. Popup bounds remained unchanged and the underlying native Page was visible; native OS keyboard selection succeeded.

The new package is selected by the existing canonical Ubuntu Desktop Entry. Three fresh ordinary-profile `gio launch` cycles passed with backend readiness, correct executable/WM_CLASS/AppArmor/profile lock, graceful closure of the first two owned instances and the third instance left open. No physical Dock click or new GNOME login is claimed. Exact package hashes, process IDs, cleanup measurements and remaining acceptance boundaries are recorded at the start of HANDOFF.

## 24. Description-only mouse submission and mode boundaries — 2026-11-11

The prior Enter-only acceptance missed a shadowed `canSubmit` inside `ChatInput.onFormSubmit`. The visible enabled state included descriptions; the mouse handler did not. `ddd529b` removes that second predicate, shares content readiness between handlers/button, labels multiple descriptions by area name while preserving typed IDs, and restores captured pending attachments on failed submission outcomes.

The saved reported `<tool_code>` response is text, not a structured call; no structured calls were persisted in that session. Its current DB mode is auto, which is not proof of its mode at the historical request. Goose already strips Chat schemas and blocks execution; those policies were preserved. `live_browser.rs` now branches only browser instructions on actual session mode and presence of a selection. Chat is passive and explains its inability to use tools; Agent keeps permitted source investigation and repair instructions. No output filter or parallel authorization mechanism was introduced. Template/supervisor/MTP/discovery/offload settings were not changed without evidence.

The final packaged four-case matrix confirms Chat schemas=0 and Agent schemas=37 (20 browser tools plus shell and other existing tools), without fixture source changes from provider requests. Mouse/Enter, whitespace/no-description disabled states, exact single description, project/DOM evidence, compact history and edit/resend are provider-tested (7 E2E PASS). One native browser regression E2E and 10 Rust registry/mode/negative/positive tool tests passed; negative malicious calls are skipped with zero effects and bounded by the existing max-turn mechanism. Clippy, formatting, TSC/ESLint and 12 unit tests passed. Three new-hash ordinary-profile Desktop Entry starts passed; details/hashes are at the top of HANDOFF.

Real Qwen is not claimed: authenticated managed gateway GET /models returns 200 after startup, but no matching resident llama-server exists. A model generation was not sent to trigger a new load. Remaining acceptance also includes a full failed-transport UI case and a multi-area provider matrix (draft separation and registry IDs are covered independently). Older packages still used by two ordinary-profile orphan Node processes are preserved pending user permission; their presence takes precedence over deletion/rollback count targets.
