# Qwen paired A/B: ускорение подтверждено, quality gate не пройден

Backend5047748, один GGUF Qwen3-Coder-Next80B Q4_K_M. Четыре последовательные загрузки,10задач×2цикла=80завершённых ответов. Второй цикл reverse order. В отличие от старых результатов здесь одинаковый chat template и полный набор настроек;60пар comparisons имеют одинаковые hashes formatted prompt и одинаковые settings кроме cache budget. Во всех80timings cache_n=0. Все80ответов stop_type=eos. Temperature0/seed42; allocation4096, GPU Q8_0K/V,8threads,batch512/ubatch128, DirectIO/no-repack/no-host/lazy-off, ngl48/n-cpu-moe48.

## Скорость и память

| Cache GiB | Decode median [min–max] tok/s | Prefill median tok/s | Изменение median decode | VRAM sampled MiB | RSS GiB | Swap-out | Hit rate |
|---:|---:|---:|---:|---:|---:|---:|---:|
|0|29.07 [28.28–29.35]|42.35|+0.0%|4004|46.03|0|—|
|8|36.96 [28.04–63.73]|48.86|+27.1%|12183|46.05|0|78.96%|
|12|46.82 [31.75–85.70]|54.69|+61.1%|16237|46.05|0|86.19%|
|16|56.25 [33.99–94.17]|64.72|+93.5%|20291|46.05|0|90.73%|

VRAM — общий sampled peak каждые2s, не точный process peak. RSS не вся RAM; last cgroup anon/file stats после cleanup не являются peak. Swap процесса/cgroup0, net global growth0, pswpout0, OOM events0 во всех четырёх прогонах. Существующий swap и swap-ins не скрываются: это отсутствие нового swap-out, не отсутствие swap вообще. Минимум MemAvailable8.57GiB. GPU KV51MiB при allocation4096; recurrent state отдельно.

Медианы парного изменения по task/repeat:8GiB +26.7%,12GiB +60.4%,16GiB +95.5%. Это другой показатель, чем отношение общих медиан в таблице. При8GiB одна задача медленнее baseline на4.1%; при12/16все измеренные task/repeat быстрее. Каждая configuration загружена один раз; два цикла не заменяют независимые повторные загрузки. Нет CI/confidence interval.

| Cache GiB | Первый цикл median decode | Reverse cycle median decode | TTFT median с | Load-to-health с |
|---:|---:|---:|---:|---:|
|0|29.21|28.93|1.187|44.68|
|8|36.22|37.61|1.134|44.67|
|12|45.58|47.28|1.005|44.70|
|16|52.86|57.16|0.892|44.71|

Только первый TypeScript запрос после загрузки полностью cold для expert cache; остальные задачи первого цикла наследуют cache. Нельзя называть весь первый цикл cold. Prefill/TTFT зависят от длины prompt; фактические counts, cold-first и per-task metrics сохранены в qwen-ab-performance.json. Hit rate/upload counters агрегированы за весь процесс, не per-request.

## Автоматическая и ручная оценка

88автоматических проверок:72pass/16fail. Все24strict TypeScript typechecks,24functional-case groups и16exact-JSON checks прошли. Проверка присутствия запрошенных assertions:8pass/16fail; ошибки одинаковы во всех режимах. На уровне ответов10из20в каждой configuration требуют ручного review; их нельзя считать автоматическими успехами. Новых автоматических отказов cache относительно baseline0.

Сам evaluator проверен на known correct fixtures и двух намеренных регрессиях; обе обнаружены. Его Node VM с timeout не заявляется security sandbox. Hash сравнение показало10/20ответов byte-identical baseline/cache для каждого cache budget.

Ручной review выявил воспроизводимый локальный регресс: baseline объясняет Dijkstra корректно в обоих циклах; при8/12/16GiB оба цикла утверждают cost−2 для пути с весами2 и−3. Правильный cost−1. Это6cache observations против2корректных baseline observations при одинаковом formatted prompt. Общая статистическая деградация на широком датасете не доказана, но quality gate «нет воспроизводимых ошибок относительно baseline» не пройден. Другие общие недостатки: React initial вне0..10 не clamped; алгоритмические ответы пропускают требуемые assertions.

## Причина: что проверено и что нет

Исходники: router выбирает expert ids до build_moe_cache_slots; SLRU remaps их в slots. Upload использует исходные byte ranges по expert_size без requantization. Cache path выполняет matmul на GPU, no-cache — CPU host experts. Разные kernels/arithmetic могут изменить greedy token и дальнейшую траекторию даже при seed42/temp0; это возможное объяснение, не доказанная причина.

Проверен actual SLRU struct pinned source:20,000requests,944,705selected-expert identity checks, разные capacities, duplicate ids, eviction, seen generation overflow. PASS. Эта проверка НЕ подтверждает корректность CUDA transfer/sync и НЕ исключает cache/backend bug. Нельзя утверждать, что ошибка модели обязательно вызвана повреждением весов, или что cache полностью безопасен.

Следующий диагностический шаг: один фиксированный teacher-forced prefix, n_probs/logits для CPU/no-cache и cache, одинаковые token ids, сравнение ранних logits до первой генерационной дивергенции; отдельно проверка copied expert bytes/slot lookup и CUDA numerics с эталоном. Текущий server/benchmark не инструментировался для этого.

## Решение об интеграции и оставшиеся проверки

Интеграция в приложение и UI НЕ выполнялась: ускорение есть, но качество не получило требуемого подтверждения. MTP после успешного A/B не запускался, поскольку quality gate не пройден. Advanced Layer Placement также не менялся. Model profiles, production runtime, main, v0.3.1 и assets не затронуты. Electron/TS/Rust/launcher regressions не запускались: product code не менялся.

Новых16K/64K/filled long-context прогонов нет; предыдущая64Kallocation с816MiBGPUKV остаётся отдельным старым наблюдением и не заменяет paired long-context validation. Полная готовность функции не заявляется.

## Системная настройка и тесты

Авторизованная сессия InvocationID7dab4a70c7f74ee586b48f2f1699e2ba: фактическое original60, перед тестами0. EXIT cleanup подал stop; проверены original60/restored60/status restored, service Resultsuccess/inactive, фактический sysctl60 и отсутствие CUDA compute processes. JSON подтверждения сохранён. Системные настройки восстановлены раньше30минут. Swapoff/drop_caches, постоянные sysctl и пользовательские процессы не затрагивались.

5memory-policy tests,3restoration tests, evaluator regression self-test и SLRU invariant test прошли. Скрипты и результаты сохранены в feature/advanced-placement-moe-acceleration; push/merge/release не выполнялись.
