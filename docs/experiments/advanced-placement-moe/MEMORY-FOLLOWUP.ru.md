# Продолжение: безопасность памяти, 2026-10-31

GPU и production runtime не изменялись. На старте: MemAvailable 59,805,581,312 bytes, swap занят 3,800,752,128 bytes, PSI avg10=0; другой CUDA compute process отсутствовал. vm.swappiness=60. Занятый ранее swap не считался новым swap-out.

## Разные проверенные режимы GPT-OSS

Все под cgroup MemoryMax=51G, MemorySwapMax=0; watchdog останавливает только свой server. Новые пороги: net swap growth >128 MiB ИЛИ aggregate swap-out >32 MiB; PSI avg10>10% при MemAvailable<10 GiB. Sampling каждые 2 с допускает небольшой overshoot. Процесс и cgroup во всех прогонах swap0; OOM events0. Полные агрегаты в memory-investigation.json.

| Model / режим | Cache budget | Decode tok/s | Prefill tok/s | VRAM sampled MiB | RSS GiB | Swap | Hit rate |
|---|---:|---|---|---:|---:|---|---|
| GPT-OSS DirectIO | 0 | нет | нет | 15648 | 4.09 | process0; global growth38 MiB | нет |
| GPT-OSS mmap NUMA isolate | 0 | нет | нет | 1166 | 9.41 | process0; global growth0; PSI stop | нет |
| GPT-OSS mmap isolate, revised PSI guard | 0 | нет | нет | 1160 | 50.28 | process0; global growth94 MiB | нет |
| GPT-OSS DirectIO/no-host/lazy-off | 0 | нет | нет | 15764 | 2.83 | process0; global growth40 MiB | нет |
| GPT-OSS DirectIO/no-host/lazy-off/no-repack | 2048 MiB | нет | нет | 15844 | 15.90 | process0; global growth47 MiB | нет |
| Qwen suite4K, mmap | 0 | нет | нет | см. JSON | см. JSON | watchdog swap-out | нет |

Это остановленные загрузки, не benchmarks. Ни один новый GPT режим не дошёл до generation/cache telemetry. Наличие cache CLI argument не выдаётся за работающий GPT cache. Старые Qwen результаты остаются предварительными; разнообразная suite остановлена на первой конфигурации, остальные бюджеты автоматически не запускались.

## Выяснено по исходникам и allocation logs

- mmap implementation может MAP_POPULATE весь файл. NUMA flag отключает prefetch лишь при фактическом is_numa; на одноузловой машине сам --numa isolate этого не гарантирует.
- DirectIO поддерживается upstream, читает через O_DIRECT. Без lazy-off сохраняются возможные lazy mappings. В последнем тесте cgroup file лишь около42 MiB, anon около15.8 GiB: существенно меньше файлового дублирования, но global swap-out всё равно был.
- no-host не означает no-repack. В no-host run CPU_REPACK allocation45182.81 MiB. --no-repack меняет это на CPU45916.12 MiB, CUDA14522.38 MiB. Меньше файлового дублирования само по себе не остановило global reclaim.
- Большой virtual buffer allocation не равен фактически резидентной RAM. cgroup file может быть меньше RSS отображаемых страниц из-за уже существовавшего cache и иной charge ownership. Ни RSS, ни MemAvailable отдельно не доказывают безопасность.
- mlock не проверялся: принудительное удержание десятков GiB увеличивает риск вытеснения пользовательских процессов. Принудительная очистка cache, swapoff, изменение system configuration и завершение чужих процессов не выполнялись.

Доказано давление swap при текущей политике/состоянии хоста, а не несовместимость GPT-OSS с RTX3090/64GB. Запрошено отдельное разрешение на временное vm.swappiness=0 с восстановлением60; до ответа не применяется. Это не отключает swap и не гарантирует нулевой swap-out, guards должны остаться включёнными. Если разрешено, следует запускать изменение и восстановление одним контролируемым lifecycle с finally/trap, сначала один GPT baseline, затем cache budgets при наличии резерва. Полный swapoff не предложен как необходимый.

## Подготовлено дальше

scripts/moe-evaluation-prompts.json: семь независимых задач (TypeScript, React, binary search, code review, Dijkstra, разговор, fact extraction). Runner применяет /apply-template, сохраняет ответы, completion timings и помечает first-request-after-load, sequential-distinct и warm-cycle. Нет synthetic warmup в suite. scripts/run-qwen-moe-suite.sh запускает последовательно0/8/12/16GiB при одинаковом allocation4096 и останавливает серию на первом сбое. 512 output token limit ещё не гарантирует завершённость; stop_type нужно проверять перед quality оценкой. Следующие16K/64K и filled context ещё не запускались.

speculative-metadata.json получен существующим metadata reader без чтения весов. Tokenizer hashes совпадают в обеих target/draft парах. Qwen nextn_predict_layers=1; eagle3 target_hidden_size=2880. Это необходимые, но недостаточные условия. Runtime содержит разные реализации draft-mtp и draft-eagle3; EAGLE требует3 extraction layers. Generation/speculative quality и дополнительная память не проверены. Модели не скачивались.

Cache graph использует выбранные router ids, затем remapping в slots; cache путь выполняет ggml_mul_mat_id на cached GPU weights. CPU vs CUDA arithmetic является возможным объяснением расхождения greedy outputs, но причинность не доказана. Нет оснований утверждать исправность всех экспертных весов или отсутствие quality regression без generation tests.

5 unit tests memory policy прошли: net growth, swap-out при нулевом net growth, существующий swap, PSI с/без недостатка RAM. Python syntax и shell syntax прошли. Runner теперь до запуска требует cgroup MemorySwapMax0 и конечный RAM limit<=55GiB. Application/UI/runtime profiles не менялись: основное исследование не завершено; интеграция и TS/Rust/UI regressions отложены.
