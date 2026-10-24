# Native Browser input, model availability and completion discipline

Рабочая ветка: `improvement/v0.3-browser-input-model-completion`, от `9e383d1`.

## Подтверждённые причины

### Ввод Native Browser

Существующий прозрачный Native shield не отменял wheel/default touch behavior. Его middle-button handler намеренно разрешал изменение presentation pan при agent ownership. Теперь shield отменяет физические mouse, wheel, touch, drag, context menu, auxclick и keyboard defaults. Он покрывает только Browser panel; чат, Stop и renderer controls доступны. Project WebContentsView остаётся живым, его CDP transport не отключается. Агентные fill, Tab и wheel продолжают работать. Возврат user ownership скрывает shield на той же Page.

### Доступность моделей

Startup, фоновые перечитывания и refresh после настройки профилей независимо записывали `models` в Zustand. Отложенный старый ответ мог заменить более свежий снимок доступности. Воспроизводимый deferred-response regression подтверждает этот дефект. Все три writers используют общий номер запроса; публикуется только последний запрос. Неудачный refresh сохраняет последний снимок.

Сам `ggufFileAvailability` заново проверяет stat/read/header и split shards: отрицательного кеша доступности нет. Повторное сохранение профиля раньше запускало общий refresh, поэтому могло обновить несколько моделей одновременно. Существующий polling/focus refresh сохранён. Добавлена компактная кнопка «Обновить доступность моделей» с RU/EN tooltip, busy/error состоянием. Она вызывает существующий models:list, перечитывает сохранённые GGUF и mmproj, ничего не сохраняет и не загружает веса. Доступность projector передаётся отдельно от возможности текстовой загрузки модели.

Историческую причину каждого случая с настоящими Qwen80B/HyperNova доказать нельзя: в имеющейся трассе нет соответствующего startup filesystem error. Отсутствие диска/поздний mount не объявляются установленной причиной. Исправлена подтверждённая гонка; проверены холодный процесс с отсутствующим shard/projector и появление файлов после запуска.

### Продолжение проверки Qwen

Прочитана существующая пользовательская трасса только для диагностики; пользовательские файлы и история не изменялись. План из шести шагов создала модель: помимо поиска она включила сетку товаров, HeaderBar и меню категорий. После измерений html/body она сама открыла другие маршруты, а после отказов решила читать соседние страницы. В трассе 41 Browser-вызов, 4 REGION_ROUTE_MISMATCH и 5 DUPLICATE_FAILED_OPERATION. Runtime не давал обязательной команды начать аудит магазина. Grounding-инструкция безусловно советовала проверить sibling instances/routes; теперь дополнительные маршруты требуют связи с изменённым общим кодом или явного пользовательского scope.

Выявлены также реальные препятствия Runtime:

- сравнение URL по строкам различало пустой `?` перед hash и отсутствие `?`;
- inspect html/body не связывался с выделенным дочерним элементом;
- достаточное CSS evidence позволяло избежать generic verification review только при зарегистрированных deliverables;
- пути мутаций могли быть относительными, а checked_paths observation — каноническими; это давало ложный verification gap;
- не было состояния skipped для уже ненужных опциональных шагов;
- отказ по маршруту отсутствовал в общем ограничителе эквивалентных Browser-ошибок;
- кеш отказов мог запрещать прежний inspect даже после явного восстановления исходного маршрута.

## Реализация

`sameBrowserUrl` нормализует пустые query/hash-разделители посредством WHATWG URL. Настоящие query, hash route state, origin/port сохраняются. Helper применяется к route guard, focus/navigation/recheck, binding и проверке исходных условий. В исполняемой в странице проекции та же ограниченная нормализация самодостаточна. Rust сохраняет пустой query delimiter как эквивалентный, не удаляя `?` из значения параметра.

DOM inspect содержит root/body clientWidth/scrollWidth и ограниченный список сохранённых anchors, однозначно найденных внутри измеренного элемента. Так проверка документа может подтверждать геометрию исходной области. Проверяются исходные URL, CSS viewport, актуальность страницы, revision изменённых исходников. Относительные aliases разрешаются в настоящем project scope и добавляются к checked_paths только при совпадении канонического файла и текущей trusted revision. Совпадение hash у разных файлов не считается совпадением путей.

Ledger хранит `observed_css` с геометрией и стилями, `pass:false`, без formal criterion coverage. Для CSS-only задачи такое свежее scoped observation может позволить финальный ответ с фактическими измерениями, включая задачу без deliverables. Это не автоматическое завершение: модель должна сопоставить факты с целью, а явные критерии, реальные ошибки, неизвестные изменения и изменения логики не получают этого исключения. Formal Verified не выдаётся за DOM observation.

Общий `check: runtime`, как и `check: browser`, допускает это ограниченное освобождение от повторного review. Это не признание любого runtime requirement проверенным: нужны CSS-only paths, сохранённый group ID исходной области, совпадение URL/viewport/anchor, свежая страница и доверенные ревизии файлов. Test/build/static и независимые immutable criteria этим наблюдением не удовлетворяются. Непройденные проверки остаются блокирующими.

Adaptive ON получает компактную completion boundary instruction: закончить после достаточного evidence исходной цели; дополнительные маршруты обосновать, опциональные шаги исключить с причиной. OFF по-прежнему убирает только дополнительную adaptive instruction, инструменты и Ledger доступны. Plan `skipped` требует причину, переживает persistence/Continue и не изображается как выполненная работа.

Для намеренной дополнительной диагностики доступен `supplementary_reason` (8–240 символов). Он не меняет approvals/origin restrictions и не связывает чужой маршрут с исходным region evidence. Явный возврат на исходный маршрут разрешает повторить бывший environment-dependent вызов, сохраняя security denials, другие проекты, screenshot budget и loop history.

REGION_ROUTE_MISMATCH, INVALID_SELECTOR, DUPLICATE_FAILED_OPERATION и прежние отказные категории используют общий bounded guard: третья неуспешная попытка даёт guidance, четвёртая использует существующий resumable Stop/checkpoint. Чередование категорий/действий не сбрасывает счётчик. Настоящие изменения сбрасывают его через существующий механизм progress. Новая Pause не вводилась.

## Проверки

Настоящий Qwen3.6-35B-A3B запуск на временном React/Vite fixture достиг timeout 180 секунд: **workflow не завершён успешно**. Модель изменила min-width с 380px на 300px, HMR применился, original 390×844 inspect показал scrollWidth/clientWidth 375/375, затем модель попыталась закончить. Gate отклонил финальный ответ: зарегистрированный deliverable имел `check: runtime`, а исключение принимало только `browser`. Это подтверждённая причина лишнего review. После него модель запросила формальную QA и придумала evidence ID `ev-003`; Runtime корректно отверг неизвестный ID и указал использовать IDs из verification_state. Следующая терминальная проверка не завершила workflow до timeout. Собственный model server штатно остановлен (`serverStopped: true`). Два предыдущих запуска остановились на fixture preflight до отправки задания в inference; проверка ошибочно требовала первый anchor вместо наличия правильного кандидата. Эта проверка harness исправлена.

После исправления Gate тяжёлый inference не повторяется: интеграция воспроизводится scripted provider с настоящими Rust Runtime, Electron и Vite. Это подтверждение исправленного runtime-пути, **не доказательство успешного повторного поведения Qwen**. Полные временные traces находятся в `/tmp/lad-adaptive-real-qwen-8kD6WC`; в репозиторий сохраняется только обезличенная сводка.

Acceptance запускается последовательно, без параллельных Electron окон на DISPLAY. Основной сценарий использует физический X11 ввод, исходный HashRouter URL с пустым `?`, runtime deliverable, HMR, scoped observation и skipped optional steps. Отдельный следующий task проверяет завершение без deliverable. Ни новый QA criterion, ни helper script не требуются. Остальные сценарии проверяют model cold start/refresh, ON/OFF, budget/compaction/restart, Stop/Continue, HMR, feedback/DPR 1/2, QA loop, control panels, responsive workspace и Manual/Auto Visual workflow.

Устаревший `p2-controls-electron` ожидает четыре группы настроек, хотя актуальный HEAD уже имеет пять. Его исходная ошибка expected 4 / actual 5 сохранена как legacy limitation; вместо изменения рабочего интерфейса запускается поддерживаемый `control-panel-modes-electron`. MTP modal в этом fixture не проверяется: модель fixture не поддерживает MTP. Предупреждение Vite о размере chunk существовало ранее и не исправляется в этой задаче.

Итоговые машинные результаты: [acceptance и quality gates](../test-results/browser-input-completion/validation.json). Все изменяемые fixture/runtime находятся в `/tmp`; пользовательские профили, GGUF, Online-Shop, NEXUS и chat history не использовались как изменяемые fixture. Настоящая GGUF использовалась только на чтение своим ограниченным model server.

Итог: TypeScript, ESLint и build пройдены; полный Rust suite — **418 passed, 1 ignored**. Все **11** последовательных Electron-сценариев пройдены. После последних строгих Gate-условий пересобран worker и повторён основной Electron сценарий: runtime deliverable завершился за 13 scripted запросов, следующий task без deliverable — за 4; дополнительных критериев или helper script не понадобилось. Host `/proc` проверен после последнего теста: собственных fixture-процессов не обнаружено, сигналы не отправлялись.

Основная регрессия воспроизводится после `npm run build` командой `node scripts/browser-input-completion-electron.test.mjs`. Нужны рабочий DISPLAY, Electron/Chromium и X11/XTest; тест поднимает только собственный временный Vite и scripted HTTP provider. Проверки Electron запускаются последовательно. Rust Gate/plan/loop regressions входят в `cargo test --locked --manifest-path rust-agent/Cargo.toml`.
