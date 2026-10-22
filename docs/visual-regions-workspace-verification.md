# Visual Regions Reliability & Responsive Browser Workspace

Ветка: `fix/v0.3-visual-regions-responsive-workspace`, от `65c5039`.
Проверено 22 октября 2026 в настоящем Electron/Chromium. Runtime и проекты всех новых тестов находятся в отдельных каталогах `/tmp`. Пользовательские runtime, история, GGUF, профили моделей, NEXUS и Online-Shop не изменялись. Merge, release и установка пакетов не выполнялись.

## Удаление: причина и исправление

В исходной реализации `reveal` искал UUID сначала в текущем документе, затем в неизменяемых snapshots сообщений. Поэтому после удаления активного региона клик по старому chip снова передавал его в `visualReveal` и рисовал рамку. Это не кэш WebContentsView. Отдельная кратковременная подсветка и локальный список selection дополнительно усложняли синхронизацию.

[Воспроизведение исходного сервиса из `65c5039`](test-results/visual-regions-workspace/deletion-baseline.json): после delete исторический reveal вызвал browser paint **1 раз**; исправленный сервис — **0 раз**, `deleted: true`. Это проверка причины на сервисе; реальные DOM/overlay/SQLite/renderer сценарии дополнительно проверены Electron E2E.

Теперь доступны:

- В подробностях области: «Выделение N» и явное «Удалить выделение» для каждого прямоугольника.
- «Удалить область N (количество)». Для нескольких прямоугольников появляется подтверждение с количеством.
- «Очистить все области» с явным подтверждением.

Мутации останавливают selection и удаляют обе подсветки, очищают session-local список, сохраняют SQLite и обновляют React. Revision/epoch не позволяет уже начатому readonly reveal дорисовать рамку после сброса selection. Выбранные ID и composer draft очищаются; main всё равно разрешает новые ссылки только по актуальному registry данного чата/проекта.

Последний удалённый прямоугольник удаляет область и цветовую группу. Новая пустая область существует только как заготовка в памяти: SQLite сохраняет счётчик номеров, но не пустую issue. Cancel, новая область и suspension активированной заготовки её убирают. На уровне Database есть дополнительный запрет записи пустых групп. Номера не переиспользуются, прежние ID не меняются. Новые регионы используют полный UUID; ввод `#region-…` поддерживает и прежние восьмизначные ID, и UUID.

Отправленные сообщения не переписываются. Chip удалённого региона возвращает состояние «удалена», исходный crop при наличии и metadata; он не прокручивает страницу, не рисует рамку и не разрешает navigate удалённой ссылки. Удаление registry не удаляет исторические evidence-файлы.

## Привязка и актуальность

Ранее selection пытался переискать anchor, но при неудаче оставлял исходные document coordinates. Readonly highlight вообще был одноразовой геометрией, не следовавшей за resize. Обе ветки заменены общей `projectVisualRegion` в `src/shared/browser-coordinates.ts`.

В сохранении достаточно существующих URL (включая query/hash), viewport, DPR, scroll, document rect, candidate selector/tag/confidence и исходного bounding rect anchor. Доли `(selection - anchor) / anchor.size` сохраняют частичное выделение. При новом layout берётся текущий `getBoundingClientRect` и применяются эти доли. Исходный crop и timestamp сохраняются как evidence момента выделения, без повторного снимка на каждый resize.

Одинаковая проекция используется для selection, readonly focus и свежего grounding при отправке агенту. При активном selection геометрия перепроверяется до 10 раз/с, чтобы учитывать не только resize/scroll, но и динамический CSS/layout/translate/scale. Если координаты не изменились, DOM рамок не перестраивается. Readonly подсветка живёт 2.2 секунды. Вне этих режимов overlay loop отсутствует.

Если URL другой, selector неоднозначен/исчез, anchor невидим либо transform содержит rotation/3D, старая рамка не выдаётся за актуальную. UI сообщает «Привязка устарела» и предлагает повторное выделение; ниже можно посмотреть исходный crop. При другом URL показан точный маршрут и отдельное безопасное действие перехода.

Canvas/SVG без anchor: координаты применяются только при совпадении viewport, DPR и navigation time origin. После reload или смены этих условий регион stale. Даже при совпадении координат UI явно говорит, что изменения содержимого Canvas не отслеживаются. Перенос произвольного screenshot-only дефекта между responsive layouts не обещается.

Перевёрнутые, повернутые и 3D элементы требуют повторного выбора/другого способа привязки; обычные translate и положительный axis-aligned scale проверены. Выделенная часть многословного текста при переносе строк остаётся геометрической долей элемента, а не семантическим диапазоном символов.

## Независимый viewport и GPU presentation

Используется существующая project Page, CDP transport и WebContentsView. Нового проекта, Page, cookie jar или браузерного процесса для presentation нет. Существующий отдельный hidden QA target остаётся только механизмом изолированных QA сценариев.

Настройки рядом с браузером:

- Auto; Mobile 390×844; Tablet 768×1024; Desktop 1440×900; Full HD 1920×1080; 4K 3840×2160; Custom.
- Fit; 50%, 75%, 100%, 125%. Числовой масштаб включает фиксированную поверхность с прокрутками.
- Фактический CSS viewport, масштаб показа, Browser Zoom, DSF и статус нехватки места.

Панели областей и экрана образуют компактный accordion: раскрытие одной сворачивает другую. Модельная панель не расширяется. Custom ограничен сторонами 240–4096 и 8.84 MP. Некорректные, бесконечные и NaN значения отклоняются в main.

`Emulation.setDeviceMetricsOverride` задаёт CSS viewport (с отдельным учётом WebContents zoom) и параметром `scale` масштабирует результирующее изображение. Это не `setZoomFactor`: `innerWidth`, media queries и bounding rect не меняются от Display Scale. DSF берётся из Electron display. Auto/Fit без emulation сохраняет обычное поведение native браузера.

Существующий WebContentsView помещён в native `View` container, который ограничивает видимую поверхность. В Fixed режиме child View сдвигается внутри контейнера. Поэтому pan не меняет `window.scrollX/Y` и не имитирует scroll сайта. Native input shield остаётся поверх контейнера и продолжает ограничивать пользовательский ввод при владении агентом.

Две обычные полосы прокрутки панели управляют поверхностью. Колесо над сайтом прокручивает сайт. Над полем «Поверхность ↔ ↕» колесо/трекпад перемещает поверхность; там же доступны стрелки клавиатуры. Focus сохранённой области при user ownership прокручивает документ к anchor и при необходимости сдвигает поверхность, чтобы показать регион. При agent ownership навигация/scroll не выполняются, подсветка остаётся на shield.

Режим сохраняется в SQLite в документе чата/проекта и в browser-session state. Model load/unload, Security, Stop/Pause и новые запуски агента не пересоздают Page и не сбрасывают viewport. Agent viewport scenarios по-прежнему выполняются в существующей изолированной QA Page; пользовательская настройка остаётся доступной. Маленькая физическая панель больше не блокирует применение фиксированного CSS viewport: изображение можно временно скрыть с объяснением, layout страницы всё равно обновляется.

## Координаты, crops и Runtime

`browser-coordinates.ts` разделяет CSS/document geometry, presentation, pan и screenshot clip. На практике это разные преобразования:

1. DOM события native страницы уже дают CSS `clientX/Y`: Electron/Chromium учитывает native поверхность, zoom и compositor scale.
2. CDP `Input.dispatchMouseEvent` требует отдельной поправки на image scale. In-process transport переводит координаты Playwright/агента; WebContents zoom CDP учитывает сам. Native-container pan здесь **не вычитается**.
3. Renderer scrollbar coordinates переводятся в DIP панели с учётом zoom приложения, затем в CSS pan. При рисовании shield используются CSS → presentation с pan и Browser Zoom.
4. CDP screenshot clip задаётся в document coordinates с переводом в pre-zoom DIP. `scale = 1 / observed DPR` нормализует output к CSS pixels; crop не вырезается из уменьшенного Fit-изображения.

Это подтверждено pixel checks красной кнопки и magenta privacy mask при DPR 1/2 и Zoom 80/100/125%. Проверены также crops при Fixed+pan и 50%, включая частичную рамку. Privacy capture общий для manual crop и QA: editable/private controls замаскированы, обе авторские подсветки скрыты. У hidden QA Page нет rAF, поэтому capture после DOM/layout task выполняется CDP, без ожидания rAF. Иначе QA останавливался по privacy timeout — эта регрессия найдена и исправлена.

Текст textarea не содержит JSON/base64. При новом сообщении main сначала проверяет живые registry IDs и project scope, затем readonly переоценивает anchor. Структурированная ссылка содержит исходный capture и отдельное `live` с timestamp, текущими URL/viewport/DPR/scroll и спроецированным rect либо stale reason. Сохранённое сообщение становится неизменяемым snapshot. Это не обещание, что DOM не изменится после отправки: Browser Tools должны обновить диагностику перед действием. Prompt явно разделяет исходное и текущее evidence и не утверждает визуальный просмотр при Vision Off.

## Реальные проверки

Команда воспроизведения набора: `npm run test:visual-regions-workspace`. Rust suite дополнительно: `cargo test --locked --manifest-path rust-agent/Cargo.toml`.

| Проверка | Результат |
|---|---|
| TypeScript, ESLint, `npm run build` | Пройдены; стандартное предупреждение Vite о крупных chunks |
| Rust | 408 passed, 1 ignored, 0 failed |
| Registry/SQLite/history, draft lifecycle, номера, координатные roundtrips, limits | `visual-regions-deletion.test.mjs` |
| Legacy IDs, цвета, маршруты, RU/EN/fallback | `visual-debugging-usability.test.mjs`, включая новые viewport labels |
| Структурированные refs, Vision policy matrix, current Ledger proof | `visual-debugging-pipeline.test.mjs` |
| Настоящий Electron workspace, DPR 1 и 2 | [DPR 1](test-results/visual-regions-workspace/dpr1.json), [DPR 2](test-results/visual-regions-workspace/dpr2.json) |
| Runtime V2 + scripted provider | [Результат](test-results/visual-regions-workspace/scripted-runtime.json): 18 workflow checks; исходный region 1920, live 390, реальный CSS fix и Verified Ledger |
| Native Responsive QA | [Лог](test-results/visual-regions-workspace/responsive-qa.txt): изоляция viewport/identity/input, Stop/Pause |
| Native Visual Layout QA | [Лог](test-results/visual-regions-workspace/visual-layout-qa.txt): 760px owner против 1440px QA, DPR 1/2, backing pixels, resize и ограниченные screenshots |
| Исходный Visual Debugging Electron workflow | `visual-debugging-electron.test.mjs`: пройден после изменения UUID/capture |

Workspace E2E использует временный UI с кнопками `width:60px; overflow:hidden; white-space:nowrap`, Canvas, password и длинной страницей. Проверяется именно DOM category `text-clipping`; input values отсутствуют в metadata. Реально проверяются closed-shadow borders через CDP, текущая позиция/ширина partial рамки, responsive layout, Electron resize, dynamic transforms (включая stale для mirror/невидимых ancestors), CSS zoom .8/1.25, Expanded/Split/show/hide, scroll, hash route, missing anchor, Canvas stale, focus, crops, Fit/Fixed/pan, UI Custom, tiny-panel regression, удаление одного/последнего/всей группы, гонка delete с незавершённым focus, подтверждения массового удаления, reload renderer, история, один target и запрет external origin. При активном агенте изменение viewport отклоняется.

Scripted provider проверяет инструменты настоящего Rust Runtime и Chromium, но не способность реальной модели рассуждать. Qwen3.6-35B-A3B в этой задаче не запускалась; для геометрии отдельная LLM не нужна. Старый real-Qwen отчёт относится к предыдущей ветке и не подменяет текущие результаты.

## 4K и ограничения измерения

В presentation нет screenshot/screencast loop, base64 frames и буферов передачи в renderer. Страница рисуется обычным native GPU compositor. Overlay делает максимум 10 геометрических сверок/с только при selection/краткой подсветке, не генерирует скриншоты и не перестраивает неизменившиеся рамки. Resize requests объединяются; hidden surfaces throttled. Лимиты viewport не позволяют создавать неограниченные поверхности.

На статическом 4K fixture с DPR 1/2 замеры за ~2 секунды: около 290 native rAF callbacks (дисплей ~145 Hz), 0.10–0.12 CPU seconds суммарно у процессов тестового приложения — около 5–6% одного ядра. Main RSS около 275 MiB; project renderer working set по его PID — около 133–134 MiB. Working sets могут включать shared pages, складывать их как уникальную память нельзя. Число root views остаётся 2 (контейнер project View + прежний shield), число project Pages — 1. Полные исходные метрики приведены в JSON; финальные прогоны фиксируют PID project renderer и 15–16 ms roundtrip настоящего Playwright click в 4K (включая IPC; это не OS-wide latency).

Это измерение простого fixture, не обещание FPS/CPU произвольного магазина. GPU VRAM отдельно не измерялась, нагрузочный профиль анимированного 4K Canvas не оценивался. OS-wide input latency не измерена: E2E использует реальные native input events и Playwright/CDP, а не ручную работу мышью. Screenshot-only и повёрнутые/3D anchors имеют описанные выше ограничения. Свежие screenshots не создаются автоматически на каждый resize: исторический crop явно остаётся исходным.

## Коммиты

1. `7f0c783` — deletion/persistence и безопасные historical references.
2. `d25ae99` — общая проекция и устойчивые partial DOM anchors.
3. `bda44d6` — responsive viewport, native GPU presentation/pan, координаты/crops и live grounding.
4. `test(visual-regions): verify responsive workspace and document native evidence` — E2E, artifacts и этот отчёт.
