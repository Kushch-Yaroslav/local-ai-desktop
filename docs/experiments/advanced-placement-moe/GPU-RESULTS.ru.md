# Первые GPU-измерения

Предварительные результаты; полная матрица исходной задачи и интеграция ещё не выполнены. Изменений приложения нет. Все тесты последовательно на одной RTX 3090; production binary только запускался в отдельном тестовом процессе, не изменялся.

Параметры: raw completion (не chat template), один фиксированный prompt задачи merge_intervals (58 evaluated tokens у Qwen), temperature=0, seed=42, 64 output tokens, 3 repeats, cache_prompt=false (cache_n=0), warm-up 4 output tokens. 8 CPU threads, batch512/ubatch128, Q8_0 K/V GPU offload, no speculative decoding. Предел scope RAM 55 GiB, swap 0; 6 GiB минимум MemAvailable, 2 GiB свободной VRAM. Значения VRAM ниже общесистемные, sampled каждые 2 с, а не гарантированный истинный peak.

| Qwen конфигурация | Context allocation | Prefill median tok/s | Decode median [min–max] tok/s | TTFT median с | VRAM MiB | RSS GiB |
|---|---:|---:|---:|---:|---:|---:|
| Текущий d1d3c33, CPU experts | 4096 | 44.72 | 30.43 [30.22–30.48] | 1.390 | 3731 | 46.07 |
| Новый 5047748, CPU experts | 4096 | 35.63 | 29.03 [28.51–29.19] | 1.726 | 3729 | 46.03 |
| Новый, cache 8192 MiB | 4096 | 68.53 | 37.49 [35.23–37.99] | 0.943 | 11952 | 46.11 |
| Новый, cache 16384 MiB | 65536 | 122.16 | 103.76 [43.27–107.03] | 0.576 | 20922 | 46.12 |

16 GiB cache: decode repeats 43.27, 103.76, 107.03. Сильное ускорение после прогрева на повторяющемся prompt: нельзя переносить его на произвольные prompts. Между последними двумя строками также отличается allocation контекста; прямую чистую оценку эффекта cache budget из них делать нельзя. Все prompts короткие; заполненного long context теста здесь нет. Префилл также имеет заметный разброс. Load-to-health timings и отдельные runs сохранены в results.json и исходных JSON.

## Подтверждение реального cache и памяти

Лог qwen-cache16384:

- CUDA weights: 1626.23 MiB.
- CPU-resident experts, входящие в cache groups: 43644 MiB.
- Реальный CUDA MoE cache: 16381.03 MiB.
- 23 слоя q6_K, 4419 slots; 24 слоя q4_K, 4611 slots; 37.5% expert slots в каждой группе. Не все блоки модели обязательно входят в cache groups.
- CUDA Q8_0 KV allocation при 65536: 816 MiB.
- Recurrent state: CUDA 73.28 MiB, CPU 2.09 MiB; rotation buffer 3.19 MiB.
- CUDA compute: 862.50 MiB; CUDA_Host compute 22.10 MiB.
- Backend shutdown: ubatch<=8 hits=88162, misses=9149, hit rate=90.60%, uploaded=16613.02 MiB; для больших batches 35211 экспертов скопированы из cache, 21252 MiB.

Это backend counters всего жизненного цикла (warm-up и все repeats), не per-request hit rate. При меньшей verbosity=3 info backend был скрыт, поэтому 8 GiB run не содержит полной allocation telemetry; повтор с verbosity=4 нужен для равноценного сравнения.

В cache runs process VmSwap и cgroup memory.swap.current = 0; проверены memory.max=59055800320, memory.swap.max=0. Общесистемные swap counters менялись; это нельзя скрывать или выдавать за отсутствие давления на память хоста.

## GPT-OSS: прервано из-за памяти

Проверена загрузка нового backend, ngl36, n-cpu-moe28, context4096, cache disabled. 8 последних блоков экспертов на GPU уменьшают CPU weight footprint. Лог подтвердил CUDA model14522 MiB, context82 MiB, compute554 MiB; host model45916 MiB. Sampled VRAM16245 MiB, RSS54.81 GiB. Process/cgroup swap0.

Однако общесистемный swap вырос примерно до 4.3 GiB (в текущем прогоне pswpout +820018 pages). Сервер остановлен вручную по памяти до завершения benchmark; results.json содержит failed и connection refused вследствие остановки. Контролируемого GPT baseline и cache performance нет, ускорение не заявляется. Даже при высоком MemAvailable kernel может вытеснять anonymous pages других приложений ради файлового cache. Scope swap0 не предотвращает это. В runner добавлен watchdog: остановка при росте общего swap >128 MiB; проверка синтаксиса пройдена, этот новый guard ещё не проверен повторным тяжёлым прогоном.

Перед следующим GPT тестом нужен больший запас физической RAM: освободить приложения с согласия пользователя либо исследовать менее затратный mapping/load policy с точными cgroup RSS/file/anon counters. swapoff/drop_caches и завершение пользовательских приложений не выполнялись.

## Качество и оставшаяся работа

Все три вывода внутри каждой Qwen конфигурации побайтово одинаковы. Между cache/no-cache и старой/новой сборками ответы различаются. Обе cache-конфигурации дали одинаковый текст. Ответы связные, но обрезаны лимитом 64 tokens; полноценная correctness оценка невозможна. Нельзя утверждать побитовую эквивалентность или отсутствие деградации качества. Требуются завершённые ответы, тесты на наборе prompts и численную стабильность.

Tool calling, reasoning/chat template, cancellation через API, restart/profile switching, speculative decoding, заполненный 64K контекст, PCIe hardware telemetry и UI ещё не проверены. CUDA smoke test прошёл, сборка server/bench прошла, Python py_compile прошёл. TypeScript/Rust/lint не запускались: application code не менялся. Без CPU-only бенчмарков.
