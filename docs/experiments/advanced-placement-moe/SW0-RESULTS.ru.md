# Контролируемое окно swappiness=0, 2026-10-31

Сессия local-ai-moe-swappiness-session.service, InvocationID17b239c1fdbc48cb8ac9d87cae1e24a6, root controller PID221336. Перед тестами подтверждены active/running, JSON original60/status active и фактическое sysctl0. Запуск пользователем00:30:14 EET; окно controller600s. Экспериментальный backend5047748, production/app не менялись.

## GPT-OSS: безопасный baseline и настоящий cache

Одинаково: ngl36, n-cpu-moe28, DirectIO, no-repack, no-host, lazy-off; context allocation4096; Q8_0 K/V; batch512/ubatch128, threads8; raw completion prompt59 tokens, temperature0 seed42; output128tokens, 3 repeats и короткий untimed warm-up. Scope51GiB, swap0; watchdog swap-out32MiB/net growth128MiB, reserve7GiB, VRAM2GiB, PSI с нехваткойRAM.

| Model | Cache budget | Decode tok/s median [min–max] | Prefill tok/s median | VRAM sampled MiB | RSS GiB | Swap | Hit rate |
|---|---:|---:|---:|---:|---:|---|---:|
| GPT-OSS | 0 | 20.60 [20.58–20.84] | 28.80 | 16440 | 45.41 | process/cgroup0, global swap-out0 | — |
| GPT-OSS | 2048 MiB | 8.22 [8.10–9.73] | 28.79 | 18483 | 45.41 | process/cgroup0, global swap-out0 | 9.08% |
| GPT-OSS | 4096 MiB | 13.86 [13.81–13.91] | 29.37 | 20554 | 45.42 | process/cgroup0, global swap-out0 | 46.31% |

TTFT medians2.055/2.055/2.015s; load-to-health48.71/46.74/46.71s. Min MemAvailable9.90/9.82/9.74GiB. OOM events0; safety stops отсутствуют. Уже занятый системный swap не отключался и не освобождался: были swap-ins111/1478/108pages, поэтому «нет swap activity вообще» не утверждается. pswpout всех трёх прогонов0, net swap growth0. VRAM общесистемная и sampled2s, не гарантированный истинный peak. RSS не эквивалентен total RAM footprint; cgroup last stats после cleanup нельзя выдавать за peak anon/file.

GPU model14522.38MiB, host45916.12MiB. GPU KV allocations76.50+4.52MiB, CPU0.27MiB; это архитектурные cache components, не универсальная full-attention формула.

2048 budget: real CUDA cache2042.30MiB;27слоёв MXFP4,161slots(4.7%); hits3936, misses39422; uploaded496985.72MiB.4096 budget: real CUDA cache4084.61MiB;323slots(9.3%); hits20081,misses23277;uploaded293448.75MiB. Большие batches копировали также данные из cache. Telemetry агрегирована за весь процесс, включая warm-up и3repeats; это не per-request counters и не измеренный hardware PCIe throughput.

Вывод: GPT MXFP4 expert cache в этой сборке фактически работает, архитектурной несовместимости не обнаружено. Но оба бюджета медленнее baseline при данном размещении. Большой объём upload и низкая/средняя доля hits согласуются с overhead/churn; причинность требует отдельных transfer measurements. Новое размещение с меньшим staticGPU footprint и большим cache budget ещё не проверено. Нельзя обобщать на все prompts и contexts.

## Ограничения качества

Все GPT ответы ограничены128tokens, stop_type=limit. Это preliminary performance tests, не завершённые quality tasks. Различия greedy outputs между cache/no-cache остаются; качество и отсутствие semantic degradation не подтверждены. Speculative decoding не запускалось. Заполненный long context не проверялся.

Runner усилен: SIGTERM переходит в cleanup KeyboardInterrupt, optional --require-swappiness-zero запрещает запуск/продолжение при окончании разрешённого окна. Первый baseline запущен до добавления этого флага, завершился штатно задолго до конца окна. Cache/Qwen запускались с флагом. Политика памяти, system settings кроме временного swappiness и production runtime не менялись.

## Qwen: разные chat-template задачи

Все14ответов завершились EOS, не token limit. Применён /apply-template модели; prompt cache отключён. Семь задач в двух последовательных циклах, без synthetic warmup. DirectIO/no-repack/no-host/lazy-off, context allocation4096, cache16384MiB; остальные параметры как у GPT кроме48слоёв/48CPU-MoE. Это отдельная серия, не прямое сравнение с прежними raw completion.

| Model | Cache budget | Decode tok/s | Prefill tok/s | VRAM sampled MiB | RSS GiB | Swap | Hit rate |
|---|---:|---:|---:|---:|---:|---|---:|
| Qwen |16384MiB|55.28 median [34.53–80.95]|61.07 median|20351|45.60|process/cgroup0; global swap-out0|90.82%|

TTFT median0.832s, диапазон0.637–8.211s; длинный fact extraction prompt занимает больше времени, чем короткие задачи. Min MemAvailable9.47GiB. Cache hits1381175, misses139624, uploaded253931.27MiB. Статистика агрегирована по процессу.

| Task | Первый цикл decode tok/s | Второй цикл decode tok/s |
|---|---:|---:|
|typescript|52.95|54.17|
|react|63.08|61.86|
|algorithm|54.76|55.80|
|review|51.97|53.22|
|explain|68.37|69.86|
|conversation|78.09|80.95|
|facts|35.33|34.53|

Только первый запрос TypeScript имеет полностью cold expert cache после загрузки; остальные первого цикла уже наследуют cache предыдущих задач. Все7ответов побайтово совпали между циклами. Извлечение фактов дало точный ожидаемыйJSON. Сгенерированный lower_bound прошёл464сравнения с bisect_left, включая empty/duplicates/bounds. Но обнаружены quality defects: React не ограничивает initial prop (20 нарушает0..10), нет ясных accessible labels; binary search не включает запрошенные тестовые assertions; Dijkstra содержит ошибку−2 вместо−1; code review меняет Response[] на JSON[] без требования. Нельзя приписать ошибки cache без paired no-cache suite. Подробности sw0-quality.json.

Полная матрица0/8/12/16GiB и16K/64K/filled long context, speculative decoding остаются на следующие согласованные окна; приложение не менялось.

## Завершение и восстановление

После окончания Qwen создан runtime/moe-swappiness-session.stop. Фактическое чтение /proc/sys/vm/swappiness подтвердило60; контроллер original60/restored60/status restored. Systemd Result=success, ExecMainStatus0, inactive. CUDA compute processes отсутствуют. JSON подтверждения сохранён в sw0-controller-restored.json. Все тесты закончились до автоматического истечения окна. Swapoff, drop_caches, постоянные sysctl и пользовательские процессы не затрагивались.
