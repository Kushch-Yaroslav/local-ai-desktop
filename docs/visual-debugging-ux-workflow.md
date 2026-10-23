# Visual Debugging UX and workflow

## Findings before implementation

- The browser toolbar renders LiveBrowserState.url, but the separate preview input is an unsynchronised local draft. Main-frame navigation (including hash) already emits current URLs from ProjectBrowserSession.
- detect runs inspectResponsive on the current, owned Page and captures at most twelve visible candidates. It neither calls an LLM nor performs a responsive matrix or Vision audit.
- The transfer action dispatches visual-region-draft. Composer stores structured references separately; only message submission starts inference. The main process revalidates references against the current chat/project registry.
- On submission each referenced issue is bound to the logical task. Existing document() projects implemented/verified deliverables from Task Memory, but may overwrite a manual Unresolved decision. Current proof filtering checks coverage/epochs but not original region route/viewport or clipping semantics.
- Agent ownership blocks user navigation, selection and viewport mutation. Read-only reveal/crop and native presentation pan remain available. Stop/Pause uses the existing runtime lifecycle.
- Issues, numbering, colors and original geometry are stored in the chat/project SQLite visual document. Message references retain historical snapshots after deletion. There is one Verification Ledger in Task Memory.

## Integration

Use one editable address with a dirty draft, a compact workspace row and ownership strip; one action bar plus bounded, collapsible issue cards. Keep technical data behind Details. Separate manual status decisions from current runtime/check projections. Recheck initially supports text-fitting/overflow candidates with a unique, still-identifiable DOM anchor, exact saved URL and CSS viewport. Record real Browser QA evidence in the existing task ledger when an issue has an associated task; no new memory or independent browser engine.

## Пользовательский workflow

1. **Открыть браузер** использует зарегистрированный проект и известный разрешённый preview. Адресная строка отражает живой URL, включая query/hash. При вводе она становится черновиком: навигация сайта его не перезаписывает. Escape/крестик отменяют ввод. Ошибка перехода видна непосредственно в браузере; внешние origins по-прежнему запрещены.
2. **Новая область** включает ручное выделение. Несколько прямоугольников одного дефекта остаются одной пронумерованной цветной областью. **Добавить выделение** дополняет активную область. **Показывать выделения** меняет только представление.
3. Карточка показывает название, маршрут, исходный CSS viewport, количество выделений, рабочий статус, результат и время последней проверки. Просмотр, передача и красное удаление находятся на карточке. Название/цвет/ручной статус, отдельные прямоугольники, UUID/DOM/геометрия/crop и доказательства раскрываются отдельно. Удаление нескольких прямоугольников и полная очистка требуют подтверждения; исторические references сохраняются.
4. **Передать агенту** добавляет структурированные references и понятные chips с номером/названием в composer. Текст сообщения, references и изображения остаются отдельными данными. Кнопка не запускает inference. Для запуска необходимо отправить сообщение; действует прежний предел 12 прямоугольников на сообщение.
5. Ownership показывает пользовательское управление, активного агента, паузу или недоступность. **Приостановить агента** использует существующий steering/pause, а не перехват управления. Во время agent run просмотр/crop/focus доступны, навигация/viewport/редактирование ограничены существующими IPC permissions. В узком окне браузер занимает workspace; передача областей переключает к чату.
6. **Проверить страницу** — начальный Auto: inspectResponsive текущей Page и текущего CSS viewport, до 12 видимых DOM/layout-кандидатов, без LLM/Vision. Это не обход сайта и не мультимодальный аудит. Кандидатов можно просмотреть, подтвердить, отклонить и передать агенту.

## Статусы, QA и Ledger

- Сохранённый до обновления ручной Unresolved также защищён при миграции provenance. Завершённый связанный run без исправления не оставляет вечное In progress: автоматическое состояние становится Unresolved.
- Ручной статус помечен «Решение пользователя» и не переопределяет Runtime. В частности, ручное Unresolved сохраняется после успешного QA и reload. Результат QA показывается отдельно. Явная свежая успешная перепроверка может закрыть вручную подтверждённую проблему как Verified; ручное Unresolved остаётся защищённым до изменения решения пользователем.
- issue связывается с logicalTaskId и generationId при отправке references. Автоматическое In progress соответствует действительно running связанному run. Fixed выводится из implemented/verified deliverable как заявление об исправлении, а не из факта завершения ответа.
- Для автоматического Verified требуются однозначный исходный anchor и текущие evidence с `qualified=false`, полное покрытие критериев, verified deliverable и фактические text_fit observations каждого выбранного элемента на исходных URL/viewport. Общий layout-pass или другая страница/ширина этого не доказывают. Failed/Blocked/Partially Verified не превращаются в Verified. «Дефект сохраняется» выдаётся только при измеренном failing text_fit; посторонняя runtime error страницы оставляет проверку неподтверждённой.
- **Перепроверить исправление** первоначально поддерживает до шести DOM-регионов одной страницы/исходного viewport с кандидатами text-clipping/overflow и однозначным anchor. Проверяются идентичность текста и реальное размещение text ranges внутри элемента/обрезающих ancestors, включая вложенные span. Наличие полного текста в DOM само по себе недостаточно.
- QA выполняется на той же Native Page, в исходных условиях. Затем в finally восстанавливается весь пользовательский workspace: viewport, scale/Fit/Fixed и pan, без смены session identity. Callback viewport management в существующем QA runner предотвращает сброс CDP presentation через обычный Playwright setViewportSize. На время QA ввод защищён штатным ownership shield. Ошибка селектора, origin, таймаут или потеря anchor дают «Не удалось проверить»/«Не подтверждено».
- Повторный переход на тот же HashRouter URL может не загрузить новые assets; при отсутствии response выполняется настоящий reload. Evidence включает свежие source revisions и ограниченный project fingerprint; изменения во время QA отменяют подтверждение. Изменение состава области также требует новой проверки.
- Результат сохраняется существующим Browser QA как report. Для связанной задачи в существующий Verification Ledger добавляется реальное наблюдение, без подделки coverage неизменяемых acceptance criteria и без автоматического verify deliverable. Issue хранит ссылки, а не вторую копию Ledger. Несвязанный с agent task ручной QA сохраняет report-reference; проверка актуальности использует этот report.
- Статусы и source evidence проверяются на актуальность. Для dev server без прямой source map используется ограниченный fingerprint проекта; это не является доказательством, что DOM сопоставлен конкретному исходному компоненту. Fingerprint для такого fallback кешируется не более пяти секунд; файловые revisions проверяются отдельно. Исторические результаты остаются доступными.

## Проверки и ограничения

Подробные результаты и снимки: [test-results/visual-debugging-ux-workflow](test-results/visual-debugging-ux-workflow/).

Реальный Qwen3.6-35B-A3B UD-Q4_K_M запускался через UI composer с собственным временным llama-server и fixture-проектом. За 72.132 s модель прочитала исходник, определила clipping вместо overlap, исправила общий CSS двух кнопок и выполнила text_fit на исходных query/hash и 1920×1080. Runtime зарегистрировал Verified и связанный Ledger evidence; отдельная ручная перепроверка также прошла. После исправления clientWidth/scrollWidth кнопок: 181/181 и 151/151. Vision Off. Собственный server завершён; пользовательский runtime и модели не выгружались/не изменялись. Scripted SSE используется отдельно для воспроизводимых проверок Runtime, а не выдаётся за настоящий inference.

Ограничения первой версии: повторная QA подтверждает только поддерживаемую геометрию текста, а не весь дизайн, overlap, анимацию, Canvas или styling mismatch. Неоднозначные/скрытые/поворотные anchors, изменившиеся labels и разные URL/viewport внутри одной группы требуют повторного выделения или отдельного сценария. Действуют существующие bounded source/QA/screenshot budgets. Browser Tools acceptance viewport остаётся ограничен существующей схемой 1920×1600; пользовательский workspace/ручная повторная QA допускает большие preset viewport. DOM QA не является Vision. Тест на настоящей модели выполнен на небольшом HTML/CSS fixture, а не на пользовательском магазине или произвольном React-сайте.

### Итоговые проверки текущей реализации

| Проверка | Результат |
| --- | --- |
| TypeScript renderer + Electron main, `npm run build` | PASS; остаётся существующее предупреждение Vite о размере chunks |
| `npm run lint` | PASS, без warnings |
| `cargo test --locked --manifest-path rust-agent/Cargo.toml` | 409 passed, 1 ignored, 0 failed |
| Новый `visual-debugging-workflow-electron` | PASS: UI Manual/Auto, query/hash и dirty draft, видимый отказ внешнего origin, два прямоугольника, rename/color, chips/composer, scripted Rust fix, исходные 1920×1080 при live 390, точный возврат Fit/Fixed/50%/pan/viewport, Unresolved override, закрытие Confirmed → Verified после явной QA, missing/invalid selector, RU/EN, keyboard, wide/narrow, reload/delete/history, настоящий разрешённый loopback preview, самостоятельная QA без agent task и устаревание fingerprint |
| `visual-debugging-electron` | PASS: базовые DOM/Canvas/group/crop/privacy/history и Runtime/Gate. Общий layout-pass намеренно оставляет visual issue Fixed/Partially Verified, а не выдаёт неверный Verified |
| `visual-debugging-usability-electron --workspace` | PASS: 18 checks, модель/permissions/QA settings и Stop/Pause без потери session, просмотр chip при agent ownership, разрешённый preview и restart |
| `visual-region-feedback-electron`, DPR 1 и 2 | PASS: реальная overlay-геометрия, partial anchors, zoom 80/100/125, crop pixels/privacy, физический X11 middle-pan. 180 кадров, 0 тёмных; pan (700,150) → (796,198) |
| `visual-regions-workspace-electron`, DPR 1 и 2 | PASS: 390/1920/4K, Fit/Fixed, scrollbar pan отдельно от page scroll, stale/Canvas, deletion races/SQLite, input coordinates, отсутствие дополнительной live Page |
| `responsive-native-electron` | PASS: исходные identity/URL/input/scroll/**точный Auto viewport** сохраняются; cache, Stop/Pause, RU/EN |
| `visual-layout-native-electron` | PASS: независимые QA viewport, DPR 1/2, bounded captures, resize diagnostics, сохранение live session/input, Stop/Pause |
| `native-browser-shutdown-electron` | PASS: повторное закрытие, shield/window/CDP teardown и полный выход с ожидаемым Browser Hub shutdown |
| Policy/migration/pipeline/deletion tests, Vision capability, QA loop guard | PASS: scoped proof, freshness, manual override, membership invalidation, immutable history, Vision policy/image payload routing |
| Настоящая Qwen3.6-35B-A3B | PASS, отдельный результат `qwen-real.json`, 72.132 s, Vision Off; serverStopped=true |

В ходе реального Responsive QA была обнаружена и исправлена регрессия: разворачивающаяся ownership-подсказка меняла доступную высоту и CSS viewport в Auto. Ownership strip и footer теперь имеют стабильную высоту; строгий тест сравнивает viewport до/после, без ослабления assertion.

Снимки `workspace-ru-native.png` / `workspace-en-native.png` сделаны X11 с настоящей Native-поверхностью. Они показывают ручное «Не решено» после потери anchor, отдельно от старого успешного Runtime QA; актуальная повторная проверка не подтверждена. Данные сайта и inputs на снимках — только синтетические значения fixture. Browser QA captures используют production privacy masks. Это не скриншоты пользовательского магазина.

Локальные implementation commits: `2694c88` (QA/Registry/Ledger/original conditions), `f32ad40` (UX/i18n/address/composer), `a17753a` (Auto viewport при ownership), `cf11cd1` (закрытие подтверждённой проблемы после явной QA), `253971a` (legacy decisions и safeguards статусов), `577c2e3` (разделение ошибки QA и сохранения text clipping). Тесты и документация фиксируются отдельным завершающим коммитом в той же feature-ветке. Merge/release/.deb не выполнялись.
