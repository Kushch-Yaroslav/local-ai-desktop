# Stop, Browser QA и рабочее пространство — v0.3

Работа выполняется в `improvement/v0.3-stop-qa-workspace-reliability`. Пользовательские runtime, проекты, история, GGUF и профили моделей не изменяются. Испытания используют `/tmp` runtime и отдельные fixture-проекты.

## Lifecycle и причины задержек

Прежний Stop вызывал `cancelGeneration`: AbortController отменял run, отправлялся Rust cancel, через 2 секунды мог завершаться worker. Это аварийное прерывание, не прежняя пользовательская Pause. Ручная Pause отправляла структурированный steering intent: Rust закрывал сокет активного inference с интервалом наблюдения 20 мс, main отменял QA отдельным AbortController и завершал ожидающие approvals. На безопасной границе сохранялись transcript и Task Memory без дополнительного inference.

Loop Detector использовал другой путь: suspended worker ожидал control commands, мог выполнять selective context repair, а неинтерактивная остановка предлагала модели до трёх checkpoint-ходов. Именно этот путь допускал долгое ожидание. Теперь подтверждённый цикл устанавливает тот же pause_requested и использует прямой runtime checkpoint. Старые внутренние протоколы и исторические PauseCheckpoint совместимы; аварийная отмена/shutdown остаются отдельными.

Пользователь видит единственное действие **Остановить**, затем **Остановлено** и **Продолжить задачу**. IPC ждёт сохранения и окончательного завершения run; UI не записывает ложное cancelled вместо paused. Продолжение использует существующий logical task и durable transcript, не воспроизводит уже сохранённые результаты инструментов. Пользовательская Native Page и ownership возвращаются пользователю.

Stop не убивает файловую запись посередине. Уже выполняющаяся безопасная операция завершается до checkpoint; длительная terminal operation может ждать собственной безопасной границы/timeout. Мгновенная остановка произвольной shell-команды с гарантией целостности её записей не обещается.

## QA и детектор

`assertionSchema` теперь описывает условные требования: selector для text/value/visible/viewport/text_fit; diagnostic.path — поле window.__qaDiagnostics; layout принимает equals 0 без selector/path; visual_layout требует path coverage/backing/seams, а coverage/backing — selector. Для layout/text_fit/visual_layout нужен явный viewport сценария.

`INVALID_QA_ARGUMENTS` содержит stage=validation, категорию, объяснение и короткий полный пример сценария. Реальные CSS Modules selectors нужно получать из DOM. Ошибка аргументов не означает, что визуальный дефект остался; чтение DOM не даёт Verified.

Ошибки группируются по категории, исходным target/viewport/source, без id/goal. На третьей эквивалентной ошибке приходит указание сменить стратегию; четвёртая останавливает run с checkpoint и reason=repeated_tool_failure. Повторные попытки обойти QA_NO_PROGRESS также ограничены. В Task Memory хранится runtime-owned guard; Continue сохраняет его. Изменение исходников или новый валидный QA разрешают дальнейшую проверку. Другой viewport/сценарий имеет отдельную сигнатуру. Подтверждённые общие циклы сохраняют reason=loop_detected; ручная остановка — user_stop. Security denial и fatal error сохраняют существующие отдельные результаты, не маскируются под успешное завершение.

Verification Ledger, immutable criteria и существующая ограниченная Completion Gate не заменены новой памятью. Неполная проверка остаётся неполной, даже если исправление внесено.

## Region references после Stop/Continue и compaction

Выявлена потеря новых reference metadata при продолжении существующего durable transcript: app-owned контекст `regions-<currentUserId>` находился в history, которая повторно не импортируется в уже существующий журнал. Теперь scoped region/attachment/project-reference context передаётся с текущим runtime user turn в блоке `turn_evidence`. В SQLite текст сообщения и структурированные references остаются отдельными. Изображения передаются прежним отдельным каналом с соблюдением Vision policy; base64 в текст не добавляется. Содержимое страницы явно обозначено как недоверенные данные.

На wire уровне Rust может объединить продолжение пользователя с последним tool envelope, добавляя `[CONTINUED USER TURN — NOT TOOL OUTPUT]`; это существующая нормализация последовательности ролей. Проверка анализирует фактический HTTP payload после этой нормализации и после настоящего compaction, а не только renderer/SQLite. В каждом из восьми agent inference запросов сохранены UUID региона, полный query/hash URL, исходный viewport 1920×1080, selector, text-clipping и исходные clientWidth/overflow. Один отдельный summary request не расходует очередь scripted tool calls. Текст UI при этом не содержит runtime metadata.

Ещё одна подтверждённая регрессия обнаружена при навигации в `qa-loop-runtime`: fire-and-forget обновление overlay выбрасывало необработанный `Execution context was destroyed`. Фоновый refresh теперь обрабатывает смену execution world, очищает старую native подсветку и помечает привязки `dom-not-ready`; обычное обновление восстанавливает их в новом DOM. Неизвестные ошибки показываются через observer, явно ожидаемые операции продолжают возвращать ошибку вызывающему коду.

## Браузер и история чатов

**Масштаб страницы** (50/67/75/80/90/100/110/125/150%) использует `WebContents.setZoomFactor` только Native Browser. Размер физической панели не уменьшается. Auto рассчитывает доступную CSS-область как размер панели / zoom. Фиксированный preset задаёт размер поверхности при 100%; при zoom 75% preset 1920×1080 даёт фактическую CSS-область 2560×1440. Фактический viewport показывается в UI и передаётся Browser Tools/QA.

**Масштаб предпросмотра** в раскрываемых параметрах сохраняет прежний CDP presentation scale и Fit/Fixed/pan. Он не меняет CSS layout. Browser zoom, displayScale, DPR/DSF остаются разными величинами. Сохранённый регион хранит исходный фактический CSS viewport и snapshot параметров presentation; текущие координаты вычисляются DOM anchoring. Recheck устанавливает нужную CSS-область с учётом zoom и затем восстанавливает весь workspace. Privacy masks/crops используют общий native coordinate pipeline.

Одна кнопка **Открыть браузер**, после открытия — **Браузер**. Она показывает существующую Page; настройки Visual Debugging больше не создают вторую точку открытия. Split/Expanded/Chat скрывают/показывают ту же поверхность.

История чатов изменяет ширину правой границей: 200–560 px, с дополнительным ограничением по ширине окна. Стрелки меняют ширину на 20 px, Home/End выбирают границы. Кнопки сворачивания/раскрытия освобождают реальное место; width/collapsed сохраняются в UI localStorage независимо от модели. Fixed viewport и Browser Session сохраняются при resize sidebar.

## Проверки

Результаты и ограничения конкретных запусков приведены в `test-results/stop-qa-workspace-reliability/`. Scripted provider используется только для управляемого воспроизведения остановки и невалидных вызовов. Отдельный `visual-debugging-qwen.test.mjs` запускает настоящий Qwen3.6-35B-A3B на временном проекте и отдельном принадлежащем тесту llama-server; это не scripted inference.

Новые Electron проверки: silent generation Stop, repeated invalid assertions и Continue, реальная CSS-правка и text_fit retest, остановка Chromium QA/approval, native zoom и реальные painted bounds, sidebar pointer/keyboard/collapse/persistence, одна Page. Существующие регрессии проверяют Manual/Auto, immutable evidence, HashRouter, ownership/security, responsive QA, pixel crops/privacy и shutdown.

Итог: десять последовательных финальных регрессионных запусков прошли. Это `qa-loop-runtime`, feedback и workspace при DPR 1/2, live autoreload, usability с compaction, Responsive Native, Visual Layout Native и полный Visual Debugging workflow. Отдельный acceptance подтвердил семь сценариев shutdown и Stop/QA/sidebar: silent generation остановлен за 1235 мс, четвёртая эквивалентная невалидная QA вызывает checkpoint, Continue сохраняет guard, реальное изменение CSS разрешает корректную text_fit проверку. Исходный viewport восстанавливается для recheck, затем возвращаются zoom/Fit/Fixed/pan той же Browser Session. Первый acceptance имел ошибку overlay/navigation; она сохранена в отчёте, исправлена и соответствующая проверка повторно прошла.

Privacy masks проверены по реальным пикселям crop при zoom 80/100/125 и DPR 1/2. Обнаруженная гонка compositor устраняется ожиданием двух кадров после установки privacy mask перед native capture; при timeout crop не выдаётся. Это не непрерывный screenshot loop. В DPR1 feedback записано 180 кадров, тёмных кадров — 0; проверены реальные X11 middle-drag и совпадение DOM bounds с рамками.

TypeScript renderer/main, ESLint и production build прошли. Полный Rust suite: **411 passed, 1 ignored**; после него Rust production source не изменялся. Lifecycle/approval/guard/visual policy/pipeline тесты прошли. Vite сохраняет предупреждение о крупных chunks. Общий static localization audit остаётся красным из-за ранее существовавших строк в AuthorConfigurations/ModelProfileEditor; изменённый BrowserWorkspaceControls исправлен, RU/EN проверены реальным workflow. Полный localization audit не заявляется успешным.

Ранее выполненный настоящий Qwen3.6-35B-A3B run занял **64,842 с**: исправлены две кнопки, text_fit на исходных URL и viewport связан с Verification Ledger, сервер теста остановлен. Этот run не повторялся в финальной регрессии; новый путь Stop/Continue/compaction проверен scripted provider с настоящими Electron, Chromium, Rust и HTTP inference transport. Scripted тест не считается повторным настоящим Qwen inference.

Мгновенное завершение произвольной terminal command не гарантируется: сохранение checkpoint ожидает безопасную границу. Тестовые результаты не доказывают отсутствие всех возможных ошибок сторонних сайтов, GPU/драйверов и иных моделей. Пользовательские данные и проекты, merge, release и установка пакета не затрагивались.
