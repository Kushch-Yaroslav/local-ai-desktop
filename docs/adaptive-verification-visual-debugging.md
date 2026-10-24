# Adaptive Verification и актуальность Native Browser — v0.3

Ветка: `improvement/v0.3-adaptive-verification-visual-debugging`.

## Диагностика и интеграционный план

До изменений найдено противоречие: обнаружение Vite отключало файловый reload, но все WebSocket одновременно блокировались Electron session, CDP routing и CSP. На отдельном React/Vite CSS Modules fixture обычный Chromium обновил радиус с 2px до 28px, а живая Native Page сохранила 2px на том же URL. Активность JavaScript не подтверждала актуальность CSS. Пользовательский Online-Shop не изменялся.

Другие подтверждённые точки: `beginRun` сбрасывал screenshot counter; маленький пересекающийся tooltip участвовал в общей политике `layout(null)`, скрывающей Native Surface; глобальная настройка Browser QA управляла браузерной финальной проверкой, независимо от типа проекта. Реестр визуальных проблем уже хранил provenance/evidence, поэтому новая параллельная память не нужна.

План интеграции: сохранить одну Native Page и ownership; разрешить только необходимый Vite HMR transport и отслеживать наблюдаемое обновление; перенести preference и budget в существующие chat/logical-task SQLite records; оставить Verification Ledger специализированным доказательством; отделить пользовательское завершение области от QA; проверить реальные процессы Electron и inference payload.

## Native Browser и HMR

Для распознанного dev server допускается только authenticated Vite root HMR endpoint `ws://<тот же loopback host:port>/?token=…`. Прочие WebSocket, внешние origins, POST, downloads и навигационный escape остаются запрещены. Native session guard сохраняется независимо от CDP. Отдельный preview-origin не считается эквивалентным: QA возвращает `verification_context` с фактическими native/QA origin и состоянием пользовательской страницы.

Файловый watcher учитывает JSX/TSX/TS и стили. Dev server обновляет ту же страницу сам; приложение не перезагружает её после каждого патча. В Vite client устанавливается ограниченный observer `vite:afterUpdate`. После изменения исходников фиксируются время изменения, наблюдаемое HMR/load и origin. Без наблюдаемого обновления показывается «Страница может быть устаревшей» с явным обновлением. Это индикатор, а не доказательство конкретного CSS-свойства: для доказательства используется текущая DOM/CSS-диагностика.

Формальная проверка устаревшей live страницы блокируется; isolated viewport QA загружает собственное актуальное состояние того же origin и отдельно сообщает freshness пользовательской страницы. Несохранённые формы не уничтожаются автоматическим fallback reload. CSS viewport, page zoom, Fit/Fixed, display scale, pan, ownership и Region Registry не сбрасываются.

## Тестирование и проверка

Новый чат получает включённую chat-local `verificationEnabled`. Старое унаследованное глобальное значение сохраняется при миграции существующего чата; последующие изменения относятся только к нему. GGUF и профиль модели не меняются. Внутренний совместимый protocol flag `browser_qa` теперь включает только компактную Adaptive verification instruction.

ON предлагает изучить реальные конфигурации, lockfiles, scripts, документацию/CI и выбрать пропорциональные разрешённые проверки изменённого поведения. Нет таблицы React→npm/Rust→cargo и автоматического исполнителя команд. OFF убирает эту дополнительную инструкцию; tools, явно запрошенные и самостоятельно выбранные проверки, security и Ledger остаются доступны. Убрана обязательная дополнительная Browser QA final-review. Общий Verification Gate сохраняет правдивое состояние доказательств и ограниченный review.

## Инструменты и ошибки

`web_project {action:"inspect",selector:"#badge"}` возвращает ограниченные CSS scalars, геометрию и текст без private input values. Нет произвольного JavaScript/evaluate инструмента. Для радиуса доступна декларативная assertion:

```json
{"source":"style","selector":"#badge","path":"border-top-left-radius","operator":"equals","expected":"28px"}
```

Нужен явный исходный viewport; selector должен быть уникальным. Сохраняются text_fit, DOM/layout, Responsive, Visual Layout QA и screenshots. Примеры и валидация используют одни и те же supported style properties. Неоднозначные/отсутствующие anchors, неверные аргументы, infrastructure errors и partial evidence не превращаются в Verified.

Эквивалентные INVALID_QA_ARGUMENTS сохраняют прежний guard. Screenshot limit, invalid crop/selector, origin/navigation failures дают typed error и `retrySameArguments:false`; повторение capability blocker получает guidance, затем тот же resumable Stop. Реальная правка исходников меняет progress window, но не пополняет screenshot budget. При невозможности доказательства модель может завершить работу с честными ограничениями.

Для чистой computed-style QA убраны ненужные начальные, responsive и финальные screenshots: при диагностике радиуса они могли ждать compositor скрытой QA Page до timeout и не добавляли доказательства CSS-свойства. Существующие capture pipelines для Responsive/Visual Layout и живой пользовательской Page сохраняются. Проверка CSS использует фактическое scalar observation на исходном viewport, без подмены живой страницы скриншотом.

## Screenshot budget

Счётчик `agent_tasks.screenshot_count` принадлежит существующему logical task ID и conversation, а не Page/run/worker. Atomic SQL update допускает восемь explicit requests; девятый отказывается с альтернативой DOM/CSS inspection. Stop/Continue, compaction, смена страницы и restart не обнуляют его. Новое самостоятельное задание получает новый task row с нулём. Чужой chat не может расходовать task counter. Ранее сохранённые задачи без счётчика мигрируют с 0: старый неперсистентный расход достоверно восстановить нельзя.

Ручные region crops, автоматические QA captures, privacy masking и живое GPU-отображение не используют explicit budget. Их прежние отдельные ограничения на captures/bytes/regions остаются. Запрос, дошедший до explicit capture, резервирует слот до захвата; ошибка самого захвата не возвращает ресурс автоматически.

## Области и UX

`workflow` отделён от технического `status` и Ledger: «Активная область», «Работа завершена», «Оспорено». Автоматическое завершение требует связанного completed run, issue-scoped deliverable с source paths и завершённого реального file mutation этих paths. Финальный текст модели и успешное чтение DOM не достаточны. Stop/error/отказ и run без соответствующих правок не завершают область. Неустановленная связь с исходником остаётся активной.

«Оспорить» сохраняет пользовательское решение и историю, восстанавливает насыщенность рамки, добавляет исходные references в composer и снимает выбор старого continuation. Сообщение автоматически не отправляется. Новая отправка является новым логическим этапом; старые evidence остаются. Ручное принятие сохраняет provenance=user и не создаёт QA proof. Старые автоматические события не перезаписывают его.

Завершённые рамки остаются с opacity 0.35; выбранная завершённая рамка использует 0.55. Номера, исходный цвет и evidence сохраняются. Технические статусы, QA, UUID и диагностика скрыты в details. Tooltip размещается в renderer chrome вне Native Surface, поэтому для небольшой подсказки не приходится скрывать весь браузер. Политика скрытия для реальных перекрывающих модальных окон сохраняется.

## Завершение после достаточного CSS evidence

Первый настоящий React/Vite Qwen-run исправил radius до 28px и прочитал актуальный computed style, но не завершился за 300 секунд. Это **не успешный acceptance**. Последующие tool calls исходили от модели: дополнительных criteria Runtime сам не регистрирует. В прежнем region context сохранялось требование Browser QA + Ledger после правки; live `inspect` не регистрировался как наблюдение, а общий review предлагал helper script и `deliverables verify`. Эти инструкции противоречили пропорциональности CSS-задачи. Отдельно Rust проверял общий envelope criteria, но не обязательные поля style assertion: ошибочный selector/path мог попасть в immutable contract до TypeScript validation.

Теперь style criterion валидируется до изменения candidate/Task Memory. `INVALID_STYLE_CRITERION` содержит точное поле, `retrySameArguments:false`, разрешение исправить аргументы и полный валидный пример `deliverables action=criteria`. Пример проверяется Rust unit test; отказ не замораживает контракт. Эквивалентные malformed criteria (даже с новыми ID/полями) получают guidance после третьего отказа и resumable Stop после четвёртого. Guard переживает Continue. Повторное создание/удаление одного check-файла также не обнуляет окно; реальная правка другого target начинает новое окно. Это ограниченный guard, а не анализ намерений произвольной программы.

Успешное уникальное live CSS inspect сохраняется в Ledger как `observed_css`, **не** assertion pass. Сохраняются URL/viewport/selector/измеренные стили и source revisions. Оно не удовлетворяет immutable criteria, не переводит deliverable в Verified и не выдаёт произвольный DOM read за визуальное доказательство. В prompt наблюдение подписано как observation, а не FAIL. Для небольшого CSS-only deliverable Runtime не навязывает новый review, если наблюдение относится к исходным region URL/viewport/selector, актуальной странице и неизменным ревизиям всех связанных CSS paths. Явные критерии/реальные проваленные проверки сохраняют силу. Другой viewport/selector, неоднозначный anchor, устаревший source или JS-изменения не получают этого исключения. Без достаточного evidence допустим честный финал с ограничениями после ограниченного review.

Смена strategy на helper script не была автоматически инициирована Gate: это наблюдавшееся решение модели в ответ на контекст. Нельзя утверждать, что удалённые временные traces доказывают её внутреннюю мотивацию. Описанные выше причины инструкций и регистрации подтверждаются кодом; новое поведение проверяется отдельным настоящим inference.

## Очистка тестового harness

Fixture вызывает production `shutdownRuntime` перед выходом Electron: abort активных generations, ожидание безопасной границы, закрытие собственных browser sessions. Ошибка shutdown обрабатывается явно. Qwen harness всегда освобождает созданный им model-server через сохранённый ChildProcess handle даже при ошибке Electron; закрытие Electron ограничено 15 секундами. Аварийный signal к Electron допустим только после проверки текущего PPID, точного argv fixture и `LOCAL_AI_RUNTIME_ROOT`; PID/PGID и доказательства сохраняются в результате. Нет killall/pkill и поиска модели по имени. Пользовательский сервер/профили не изменяются.

## Проверки и ограничения

Результаты конкретных запусков сохраняются в `test-results/adaptive-verification/`. Scripted provider и настоящий Qwen inference различаются в отчёте. HMR observer подтверждает применение dev-server update/load; это не побайтовая гарантия соответствия произвольного bundler. Поддержан ограниченный Vite root HMR transport; иные WebSocket endpoints остаются запрещены. Автоматическое завершение области консервативно требует точного issue-scoped deliverable с подтверждёнными paths: без такой связи область остаётся активной.

Raster-регрессия сначала дала ложный «blink»: появление карточки сместило Native Surface, и фиксированная точка попала на красную кнопку. Сохранённые bounds, trace и снимок окна подтвердили отсутствие `layout(null)`/reset transforms. Проба перенесена в пустую часть общей нижней полосы; тест проверяет, что она остаётся внутри Native bounds. Повтор: 180 кадров, darkFrames=0, minLuma=240. RU regression раскрывает технические данные перед проверкой скрытого статуса; основные карточки не перегружаются ради старого тестового locator.


## Итоговое настоящее испытание

Один дополнительный настоящий Qwen3.6-35B-A3B run (Vision Off) завершился за **91,658 с**: фактическая правка `Card.module.css` 2px→28px, live inspect всех четырёх углов на исходном query/hash URL и 1920×1080, 0 explicit screenshots, 0 QA scenarios, 0 новых criteria и 0 helper scripts. Область получила workflow completed, формальное Verified не подделано. Собственный llama-server штатно остановлен; read-only проверка `/proc` по точному runtime/environment не нашла оставшихся процессов.

Это не идеально минимальный trace: первая metadata-запись имела слишком длинный `text` и была отклонена, затем исправлена; модель один раз попробовала `deliverables verify` без assertion и честно завершила с ограничением. Наблюдался один bounded review, поскольку Vite proxy не имел raw served hashes и первоначальный CSS observation ещё не попадал в Ledger. По этому конкретному trace исправлена последняя интеграция: live facts записываются с sourceBinding=`task_mutations`, используя проверенные ревизии реальных CSS mutations текущей задачи, а не модельные пути или выдуманный source map. Это остаётся observation, не assertion pass. Ответ `CSS_OBSERVATION_ONLY` объясняет, что терминал/helper script для формального ярлыка не нужен.

Последнее исправление проверено **scripted provider + настоящий Rust/Electron/React/Vite**, не повторным Qwen: реальный file edit, HMR, source-scoped observation в Ledger, шесть inference requests (пять нужных tools и финал), без дополнительного formal review, завершение области и dispute с chip. Genuine Qwen не запускалась повторно после этого изменения. Поэтому реальный inference подтверждает завершённый CSS workflow, а окончательный путь регистрации evidence/отсутствия formal detour подтверждён отдельным воспроизводимым Electron acceptance.

Финальные gates: TypeScript, ESLint, production build; Rust **416 passed, 1 ignored**. Последовательные Electron/Chromium suites перечислены в `../test-results/adaptive-verification/acceptance.json`, результаты настоящего inference отдельно в `qwen-real.json`, окончательный CSS Ledger sample в `css-ledger-scripted.json`. Старое предупреждение Vite о chunk >500KB сохраняется. Широкого форматирования crate и изменений пользовательских runtime/моделей/истории/проектов нет.

Компактный header теперь показывает именно chat-local «Тестирование и проверка», а не смешивает ON/OFF preference с последним Browser QA result. Реальный panel E2E подтвердил компактную высоту 50px, отсутствие overflow в узком окне, keyboard/help, Live Browser и persistence после полного restart. MTP modal focus в этом fixture **не проверен**: capability MTP неподдерживаемая, control корректно disabled; модель/профиль для теста не подделывались. Остальная ветка modal-теста сохраняется для поддерживаемых capabilities. Новых unhandled Promise rejections в итоговых browser/inference логах не найдено.
