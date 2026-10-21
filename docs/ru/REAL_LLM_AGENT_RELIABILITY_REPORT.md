# Отчёт: испытания Agent Runtime на реальных локальных LLM

Дата испытаний: 21 октября 2026 года. Испытания выполнялись в Electron fixture с настоящим локальным inference через `LlamaRuntimeController`, production launcher llama.cpp и Rust Agent Runtime. Runtime и проекты были отдельными временными каталогами в `/tmp`; пользовательские профили использовались только для чтения и копировались во временный runtime.

Сводные структурированные результаты: [`test-results/real-llm-agent-reliability/results.json`](../../test-results/real-llm-agent-reliability/results.json). Временные полные трассы и screenshots оставлены вне Git в каталогах `/tmp/lad-real-agent-*`.

## Оборудование и профили

- NVIDIA RTX 3090 24 GiB, AMD Ryzen 7 5700X3D (8C/16T), 64 GiB RAM.
- Backend: `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`, `0.4.1-dev`, commit `d1d3c33`.
- Qwen3.6-35B-A3B: `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`, architecture metadata `qwen35moe`.
- Qwen3-Coder-Next 80B: `Qwen_Qwen3-Coder-Next-Q4_K_M.gguf`.
- Обе модели запускались по очереди, context 65536, KV `q8_0` K/V, GPU KV offload, Flash Attention On, mmap, MTP Off, Vision Off. Это проверки поведения агента, а не сравнительный tuning MTP или benchmark.

| Параметр | Qwen3.6-35B-A3B | Qwen3-Coder-Next 80B |
|---|---:|---:|
| GPU layers | 8 | 48 |
| CPU MoE layers | 32 | 32 |
| CPU / batch threads | 8 / 8 | 8 / 8 |
| Batch / microbatch | 1024 / 128 | 2048 / 512 |
| Context / KV | 65536 / q8_0 K,V | 65536 / q8_0 K,V |
| MTP / Vision | Off / Off | Off / Off |

После загрузки, не на пике: Qwen3.6 оставляла около 18.6 GiB свободной VRAM и 52.9 GiB доступной RAM; Qwen80 — около 4.2 GiB свободной VRAM и 54.0 GiB доступной RAM. Пик VRAM/RAM отдельным sampler не измерялся. Запуски соблюдали ограничение: активна была только одна крупная модель.

## Результаты реальных сценариев

### Qwen3.6-35B-A3B

**B — исправление ошибки.** Модель прочитала реализацию и тест, поняла, что `includes` чувствителен к регистру, проверила сломанный baseline, изменила функцию и добилась прохождения `npm test`. Пост-проверка теста также прошла. Было 5 настоящих tool calls: 4 успешных и один ожидаемый отказ исходного теста до исправления. Изменение выполнено через `run_terminal`/`sed`, не через структурированный patch tool. Run занял 187 секунд; telemetry последнего turn сообщила 9.24 decode tok/s, 14,814 токенов контекста.

**D — Browser QA.** Модель обнаружила фиксированную ширину 620px и `100vw`, дважды получила отказ на неправильно оформленный `apply_patch`, затем успешно использовала `replace_text`. QA при 390×844 закончился статусом Verification Gate `Verified`, без горизонтального overflow. Было 8 реальных инструментальных вызовов: 6 успешных, 2 отклонённых patch. Один read, одна мутация, три browser actions, одно QA evidence. Vision был выключен; результат основан на DOM/layout evidence. Run занял 360 секунд; последняя turn telemetry — 8.17 tok/s.

**E/F — планирование, Pause и Resume.** Pause сохранил план и task memory после чтения проекта. В resumed run модель внесла одну правку и прогнала `node --test` (1 passed). На повторном чтении неизменённого файла Runtime показал идентификатор сохранённого observation; модель всё же выбрала полный `write_file`. В этой попытке было 16 реальных tool calls, 13 успешных и 3 ошибки: устаревшая revision для первой попытки `replace_text`, перенаправленный повторный read и безопасный отказ удалить recovery backup. Задача завершилась штатно, Verification/тест прошли. Resume занял 333 секунды; последняя telemetry — 9.02 tok/s при 18,634 токенах контекста.

**Последовательный Browser run в том же чате.** После Browser QA начался новый Agent Run. Он прочитал текущую страницу и сделал screenshot без открытия, reload или навигации. Native WebContentsView остался тем же (`nativeViewId=2`), маршрут был `https://project-preview.invalid/index.html`; run-scoped browser-session ID изменился, что ожидаемо для нового run. Модель сначала запросила clip 390×844, не помещавшийся в фактический viewport 554×703; Runtime отказал, после чего полный screenshot прошёл. Было 3 browser tool calls, 2 успешных и 1 ошибочный запрос clip. Screenshot создан при Vision Off, поэтому QA правильно остался `Not Verified` для мультимодального визуального анализа.

### Qwen3-Coder-Next 80B

**A — исследование проекта.** Модель исследовала три файла временного fixture, объяснила функцию и тест, сослалась на фактические пути, изменений не внесла. 6 инструментальных вызовов, все успешные, 3 чтения, 86 секунд. Последняя telemetry — 31.07 decode tok/s при 15,011 токенах контекста.

**B — исправление ошибки в том же чате.** Модель использовала сохранённые observations из сценария A: два повторных `read_file` были заблокированы как неизменённые, затем оба содержимого успешно восстановлены через `observation_read`. Модель изменила функцию и выполнила `npm test`; независимая проверка также прошла. 6 настоящих tool calls: 4 успешных, 2 отклонённых повторных read; ноль новых `read_file`, одна правка через `run_terminal`/`sed`/`mv`. Run занял 95 секунд; последняя telemetry — 31.14 decode tok/s при 17,472 токенах контекста.

Эти значения tok/s — telemetry последнего turn, а не средняя скорость всего run и не повторный benchmark. Суммарный prompt/completion usage всего run в доступной telemetry отсутствовал. Из результатов нельзя заключать, что обе модели одинаково эффективны на больших проектах: у Qwen80 исследовательский fixture был небольшим и оба сценария короткими.

## Подтверждённая проблема Runtime и исправление

Реальный Pause/Resume выявил несогласованность: deduplication правильно находила, что повторно запрошенный `read_file` совпадает с успешным историческим observation и текущими байтами, но новый Agent Run не переносил эту revision в своё состояние `file_revisions`. Поэтому следующий `replace_text` отвергался как `STALE_FILE_REVISION`, хотя файл не менялся. Повторный `read_file` затем блокировался deduplication и предлагал `observation_read`.

Runtime теперь восстанавливает run-local freshness только для успешного исторического чтения, если canonical source, полный hash текущего файла и сохранённая revision совпадают. Перед фиксацией состояния hash перепроверяется; отсутствующие/ошибочные observations и изменённый файл не получают доверенную revision. Добавлен регрессионный тест `unchanged_deduplicated_read_hydrates_freshness_for_a_new_run`, который также проверяет, что внешнее изменение после этого снова считается stale.

После изменения повторный реальный Qwen3.6 Pause/Resume завершился с прошедшим тестом. В той конкретной трассе модель после первоначального отказа `replace_text` и перенаправленного read выбрала `write_file`, поэтому повторного `replace_text` для измерения снижения ошибок не было. Исправление подтверждено Rust regression test; численного сокращения реальных tool calls не заявляю.

## Разделение причин

- **Runtime defect:** перенос freshness неизменённого чтения между Agent Runs отсутствовал; исправлен и покрыт Rust тестом.
- **Model behavior:** Qwen3.6 ошиблась в CSS patch formatting и в одной временной попытке указала `src/tasks.test.js` вместо `test/tasks.test.js`. Qwen80 исследовала небольшой fixture в несколько проходов по каталогам, затем эффективно повторно использовала observations.
- **Tool call / prompt mismatch:** Qwen3.6 запросила screenshot crop больше реального viewport. Runtime отказал без повреждения состояния, после чего модель сделала корректный полный capture.
- **Security:** попытка удалить файл из `.local-ai-backups` была заблокирована защитой файловой системы. Защита не ослаблялась.
- Не обнаружены зависание agent loop, потеря Browser ownership, потеря Pause checkpoint или ложное утверждение о прохождении теста в выполненных сценариях.

## Проверки

- Реальный inference на обеих GGUF через production launcher и Rust Agent Runtime.
- Electron/Chromium Native Browser: mobile QA, Verification Gate, screenshot, последовательные runs в одном чате.
- Реальные fixture `npm test` и `node --test` после исправления.
- TypeScript: прошёл как часть `npm run build`.
- `npm run build`: прошёл; Vite выдал предупреждение о нескольких крупных renderer chunks (>500 kB), но сборка завершилась успешно.
- ESLint: `npm run lint` прошёл.
- Rust full suite с разрешёнными host process permissions: 305 unit tests, 95 agent-loop tests passed, 1 прежний ignored, 3 runtime-protection, 5 tool-security; итого 408 passed, 1 ignored.
- Первый Rust run в ограниченном sandbox получил 10 ошибок процесса/изоляции; повторный host-permission run прошёл. Это ограничение тестовой среды, не изменение security policy.
- Адресный тест `unchanged_deduplicated_read_hydrates_freshness_for_a_new_run` прошёл отдельно и в полном наборе.

## Границы и рекомендации

MTP On/Off сравнение, Vision On, reasoning controls, Stop во время активного inference и пользовательский approval dialog в этой задаче не проверялись. MTP был подтверждённым backend-вариантом для Qwen3.6 по metadata/CLI в предыдущей диагностике, но оставался Off в этих запусках. Не выполнялись длинные benchmark, peak-memory profiling и длинный автономный coding project. Qwen80 оставила лишь около 4.2 GiB свободной VRAM после загрузки; для больших или multimodal задач нужен дополнительный reserve check.

Полезные следующие проверки для Qwen3.6: повторить тот же Pause/Resume prompt с точными путями и проверить, что модель использует `observation_read` перед `replace_text`; измерить MTP On только отдельным контролируемым прогоном; сравнить два одинаковых средних coding fixture по общей длительности и суммарным prompt/completion tokens. Не следует выводить предпочтение модели только из небольших task fixtures или последнего turn tok/s.

Пользовательские GGUF не изменялись. `runtime/`, чаты, профили, NEXUS и установленный `.deb` не изменялись. Тестовый runner копирует сохранённый профиль во временный runtime и отказывается стартовать при активном `llama-server`, свободной VRAM ниже 21 GiB или RAM ниже заданного порога.
