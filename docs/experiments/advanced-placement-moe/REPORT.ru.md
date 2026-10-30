# Предварительная проверка Advanced Placement / MoE

Статус: исследование не завершено, интеграция и GPU-бенчмарки заблокированы.
Исходная база: main 4fcc6c8 после v0.3.1. Удалённую актуальность проверить не удалось: DNS github.com недоступен для git. Main, релизы и теги не изменены. Production runtime не заменён.

## Реальные GGUF

Полные metadata, имена, shapes, типы и offsets тензоров: inventory.json. Чтение только metadata/descriptor, без чтения весов. Размеры ниже в GiB.

| GGUF | Архитектура | Квантование | Размер | Блоки | Эксперты / выбранные |
|---|---|---|---:|---:|---:|
| Qwen_Qwen3-Coder-Next-Q4_K_M.gguf | qwen3next | Q4_K_M, смешанные типы | 45.381 | 48 | 512 / 10 |
| gpt-oss-120b-MXFP4.gguf | gpt-oss | MXFP4 эксперты, F32/Q8_0 прочие | 59.034 | 36 | 128 / 4 |
| Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-Q4_K_M.gguf | qwen3next | Q4_K_M | 1.404 | metadata: 49 | 512 / 10 |
| eagle3-gpt-oss-120b-Q8_0.gguf | eagle3 | Q8_0/F32 | 0.791 | 1 | — |

49 блоков в metadata MTP-файла не означают наличие полной 49-слойной модели: нужно смотреть его фактические descriptors. Наличие draft weights не подтверждает совместимость. Qwen draft имеет имя Instruct, основной файл — Coder Next; совместимость требует отдельной проверки. EAGLE3 и MTP — разные технологии.

## Локальный backend

Проверен /media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server: 0.4.1-dev, commit d1d3c3396aa13a5f239109a822666c4870490ad5. Сохранён local-runtime-help.txt.

Поддерживает --n-gpu-layers, --override-tensor, --cpu-moe, --n-cpu-moe, --fit. --moe-cache-mib отсутствует и в help, и в common/arg.cpp. Поэтому CPU MoE offload здесь не является динамическим GPU expert cache.

В официальном upstream документирован --moe-cache-mib: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md . Нужен отдельный pinned checkout/build; production не трогать. Реализация eviction, telemetry, CUDA и конкретные архитектуры в новой сборке ещё не проверены.

common/arg.cpp:252 перечисляет buffer types реально загруженных устройств и отклоняет неизвестные. llama-model-loader.cpp:1228 применяет первый regex override; CPU override проходит select_weight_buft, явный иной buffer назначается непосредственно. Это не доказательство поддержки всех операций произвольным GPU buffer.

Фактические группы: blk.N.ffn_down_exps.weight, ffn_gate_exps.weight, ffn_up_exps.weight. У GPT-OSS есть также expert biases; у Qwen shared experts имеют отдельные имена shexp. Будущий compiler placement должен брать полный список из descriptors, закреплять regex (^blk\\.N\\.), учитывать порядок overrides и не смешивать routed/shared experts. Статическое размещение можно выразить overrides, но фактическая CUDA-загрузка пока не подтверждена. Специализации слоёв не приписывались.

## Память и блокер

nvidia-smi завершился кодом 9; /dev/nvidia* отсутствуют. Backend: failed to initialize CUDA, Available devices: (none). Модели не загружались. Это не повод проводить несравнимый CPU baseline.

RAM total 67,321,839,616 bytes, MemAvailable при проверке 47,181,688,832 bytes; swap уже занят 147,382,272 bytes. GPT GGUF 63,387,346,208 bytes: полную резидентность в доступной RAM предполагать нельзя. mmap не гарантирует отсутствие paging/swap. Qwen также оставляет слишком мало доступной памяти для запуска без дополнительной проверки и резерва. Необходимо повторить preflight непосредственно перед каждым запуском; не выгружать чужие процессы автоматически.

64K Q8_0 не проверено. Qwen имеет SSM/hybrid state, GPT-OSS attention с собственными ограничениями; обычную формулу полного attention на все блоки применять нельзя. KV, expert cache, weights и compute buffers должны измеряться отдельно. Ни пустая allocation, ни размер GGUF не являются peak VRAM/RAM.

| Модель | Baseline tok/s | Expert cache tok/s | Peak VRAM/RAM |
|---|---|---|---|
| Qwen | не измерено | не измерено | не измерено |
| GPT-OSS | не измерено | не измерено | не измерено |

Исторические 24–35 и 7–11 tok/s не использовались как контролируемый baseline. TTFT, prefill, transfers, warm-up, hits/misses и качество не измерены. Ускорение не заявляется.

## Интеграция и проверки

Изменения приложения/UI/профилей отсутствуют: подтверждённых CUDA-оптимизаций пока нет. Миграции не менялись. Собственный scheduler/cache не реализован. Добавлен воспроизводимый stdlib GGUF inventory reader с лимитом descriptor region 128 MiB и проверками header/count/rank. Реальное чтение четырёх GGUF успешно. storage spans включают alignment padding, это не точная стоимость backend allocation.

TypeScript/Rust/lint/UI/launcher regressions не выполнялись: продуктовый код не менялся. CUDA placement, restart, cancel, tool calling, reasoning, long context и speculative decoding остаются непроверенными.

Дальше: восстановить доступ CUDA в окружении, обеспечить git network, закрепить официальный runtime с cache в отдельной директории, изучить реализацию cache и ограничения, проверить memory preflight, затем последовательные одинаковые baseline/cache прогоны с повторениями и реальным заполнением long context. Только после подтверждения переходить к интеграции и UI.
