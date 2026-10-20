# Qwen3-Coder-Next 80B Q4_K_M: настройка llama.cpp на RTX 3090

Практический результат профилирования на одной RTX 3090 24 GiB и Ryzen 7 5700X3D. Основной режим сохраняет контекст 65 536 и Q8 для K и V. Замеры разделяют обработку prompt и генерацию: MTP ускорил продолжение длинного контекста, но замедлил prefill и требует отдельного draft GGUF.

> Это измерения на конкретном компьютере и сборке, а не стандартизированный benchmark. Скорость зависит от длины prompt, температуры GPU, фоновой нагрузки и параметров запроса. Значение VRAM — максимальное показание `nvidia-smi`, снятое примерно раз в две секунды; короткий пик между замерами мог быть выше.

## Оборудование и файлы

- Ubuntu 24.04.2 LTS, Linux 7.0.0-38-generic.
- NVIDIA GeForce RTX 3090, 24 576 MiB VRAM; драйвер 580.178.04, CUDA 13.0.
- AMD Ryzen 7 5700X3D, 8 ядер / 16 потоков.
- 64 GiB DDR4; Linux видит около 62 GiB. Swap не настроен.
- Настроенный llama.cpp: `0.4.1-dev`, commit `d1d3c33`, CUDA build, GNU 13.3.0.
- Использованный бинарник: `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`.
- Основная GGUF: `Qwen_Qwen3-Coder-Next-Q4_K_M.gguf`, 48 727 680 704 bytes (48.73 GB decimal), `Q4_K_M`.

Файл проверен по GGUF metadata: `general.architecture=qwen3next`, 48 transformer layers, embedding 2048, 512 experts / 10 active, native context 262 144. Это именно **Qwen3-Coder-Next 80B**, а не обычная Qwen3-Next-80B-Instruct. Модель заявлена как non-thinking: отдельный Qwen Thinking toggle для неё не задавался. Архитектура и non-thinking режим также описаны в [официальной карточке Qwen3-Coder-Next](https://huggingface.co/Qwen/Qwen3-Coder-Next).

## MTP: что есть в основной GGUF и что проверено

В основной GGUF распознано 843 tensor headers. В ней отсутствуют `qwen3next.nextn_predict_layers`, `nextn`/`mtp` тензоры и встроенная MTP head. Само слово `Next` в архитектуре не означает наличие MTP-весов. Прямой backend capability probe при этом подтверждает, что текущий `llama-server` поддерживает `--spec-type draft-mtp`.

Для проверки отдельного draft я использовал MTP-only Q4_K_M GGUF из [репозитория a4lg для Qwen3-Next-80B-A3B-Instruct](https://huggingface.co/a4lg/Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-GGUF). Его автор предназначает файл как отдельный speculative draft также для производных Qwen3-Next моделей и отдельно предупреждает, что acceptance и ускорение зависят от конкретной производной. Это сторонний draft от Instruct-модели, а не MTP-веса, выпущенные вместе с Coder-Next.

Sidecar проверен до запуска: 1 507 216 000 bytes, SHA-256 `1f7813cd8c944d208183ff81c83de31b82d72dbea5b45d4343ba72c1d37ee4c5`; `qwen3next.nextn_predict_layers=1`, 23 тензора, embedding 2048, context 262 144. Все пять проверенных полей tokenizer (модель, tokens, merges, BOS id и add-BOS) совпадают с основной GGUF. Backend загрузил его как draft MTP и сообщил об инициализации speculative context.

В основной GGUF нет встроенной MTP head, поэтому для MTP требуется отдельный совместимый draft. В профиле Local AI Desktop теперь есть отдельное поле **MTP / Draft GGUF**: оно проверяет архитектуру, размеры, nextn head, tokenizer, backend-флаги, размер и SHA-256 файла. Для этой пары подтверждён внешний `draft-mtp`; выбор Off не использует sidecar, On требует его успешной загрузки, Auto включает режим только после capability preflight.

| Условие | MTP Off | MTP On |
|---|---:|---:|
| Основная GGUF содержит MTP head | Нет | Нет |
| Отдельный draft GGUF | Не нужен | Нужен, 1.507 GB Q4_K_M |
| llama.cpp режим | `--spec-type none` | `--spec-type draft-mtp` |
| Максимум draft tokens | — | 2 — лучший из проверенных вариантов |
| Acceptance, 512 выходных токенов, 3 повтора | — | 450 / 540 = **83.3%** |
| Acceptance, 32K prompt, 96 выходных токенов | — | 63 / 63 = **100%**, один замер |
| Дополнительная VRAM на выбранном профиле | — | Около 1.5 GiB по парным пикам |

При `n-max=4` acceptance составил 174/258 = 67.4%, а decode в короткой серии был медленнее, чем с `n-max=2` (20.65 против 23.84 tok/s на профиле с `n-cpu-moe=48`). Поэтому для этого sidecar я выбрал `n-max=2`. Все повторные MTP-прогоны завершились без сбоя и усечения. На одинаковом длинном synthetic prompt выходные токены MTP On и Off совпали; два коротких результата отличались оформлением, но оба прошли четыре проверки слияния интервалов.

## Методика

Benchmark runner запускает только свой дочерний `llama-server` на loopback с временным портом и останавливает только этот PID. Он не использует приложение, его runtime, пользовательские модели или профильные файлы. Для каждого процесса задавались `ctx-size=65536`, K/V `q8_0`, KV offload, `--fit off`, одинаковая температура 0, top-k 1, top-p 1 и seed 42. Перед измерениями был один прогревочный запрос; в MTP метрики acceptance снимались до и после измеряемой серии.

Основные серии выполнялись по три раза с одинаковым prompt и длиной генерации; таблицы показывают медиану. Проверка длинной истории использовала 32 768 token prompt (половина 64K окна) и 96 выходных токенов. Это синтетический повторяющийся текстовый контекст, не реальный чат с шаблоном и инструментами. Для него был один запуск на профиль, поэтому длинные-context числа следует считать парным наблюдением, а не полноценной статистикой.

TTFT измеряется от HTTP-запроса до первого непустого streamed content chunk; в длинных запросах он почти полностью определяется prefill. Prompt processing и decode throughput берутся из llama.cpp timings. Память — параллельная выборка `nvidia-smi` и `/proc`; отсутствие swap подтверждено, но swap на системе не настроен.

## Таблица проверенных конфигураций

Все строки с коротким prompt используют контекст 65 536, Q8 K/V, Flash Attention On и mmap, если в примечании не указано иное. `B/UB` — batch/microbatch. VRAM peak включает графическую оболочку и другие базовые desktop allocations; process RSS на mmap включает file-backed страницы.

| CPU MoE layers | Threads / batch threads | B / UB | MTP | Output | Prompt tok/s | Decode tok/s | TTFT | VRAM peak | Повторы / примечание |
|---:|---:|---:|---|---:|---:|---:|---:|---:|---|
| 48 | 8 / 8 | 512 / 128 | Off | 96 | 38.43 | 22.87 | 1.61 s | 4 877 MiB | 3; все MoE experts на CPU |
| 48 | 12 / 12 | 512 / 128 | Off | 96 | 35.92 | 16.99 | 1.62 s | 4 873 MiB | 3 |
| 48 | 16 / 16 | 512 / 128 | Off | — | — | — | — | 4 854 MiB | Остановлено после прогрева: около 0.59 tok/s и высокая загрузка CPU; timed run не закончен |
| 48 | 8 / 8 | 512 / 128 | On, nmax 2 | 96 | 38.78 | 23.84 | 1.59 s | 6 312 MiB | 3; acceptance 85.9% |
| 48 | 8 / 8 | 512 / 128 | On, nmax 4 | 96 | 36.84 | 20.65 | 2.05 s | 6 291 MiB | 3; acceptance 67.4% |
| 44 | 8 / 8 | 512 / 128 | Off | 96 | 35.93 | 25.83 | 1.71 s | 8 838 MiB | 3 |
| 40 | 8 / 8 | 512 / 128 | Off | 96 | 46.11 | 27.27 | 1.37 s | 12 690 MiB | 3 |
| 36 | 8 / 8 | 512 / 128 | Off | 96 | 52.65 | 29.72 | 1.19 s | 16 255 MiB | 3; свободно около 8.1 GiB VRAM |
| 32 | 8 / 8 | 512 / 128 | Off | 96 | 57.14 | 30.48 | 1.12 s | 20 077 MiB | 3; свободно около 4.4 GiB VRAM |
| 32 | 8 / 8 | 512 / 128 | On, nmax 2 | 96 | 54.35 | 30.76 | 1.15 s | 21 489 MiB | 3; acceptance 85.9%, свободно около 3.0 GiB |
| 32 | 8 / 8 | 512 / 128 | Off | 512 | 57.51 | 31.27 | 1.13 s | 20 046 MiB | 3 |
| 32 | 8 / 8 | 512 / 128 | On, nmax 2 | 512 | 55.20 | 31.18 | 1.11 s | 21 472 MiB | 3; acceptance 83.3% |
| 32 | 12 / 12 | 512 / 128 | Off | 96 | 57.91 | 27.92 | 1.10 s | 19 995 MiB | 3; до 12.3 CPU cores, aggregate CPU доходил до 97.7% |
| 32 | 8 / 8 | 2 048 / 512 | Off | 512 | 57.40 | 30.14 | 1.11 s | 20 088 MiB | 3 |
| 32 | 8 / 8 | 2 048 / 512 | On, nmax 2 | 512 | 56.83 | **32.72** | 1.11 s | 21 601 MiB | 3; acceptance 83.3%, свободно около 2.9 GiB |
| 32 | 8 / 8 | 512 / 128 | Off, load mode `none` | 512 | 95.47 | 30.85 | 0.71 s | 20 340 MiB | 3; RSS меньше, но доступная RAM падала до 16.5 GiB; mmap быстрее и оставляет больше reclaimable памяти |

### 32K prompt: влияние истории и batch

| MoE CPU | B / UB | MTP | Фактически обработано | Prompt tok/s | Decode tok/s | TTFT | VRAM peak | Запуски |
|---:|---:|---|---:|---:|---:|---:|---:|---:|
| 32 | 512 / 128 | Off | 32 768 | 154.61 | 27.15 | 212.11 s | 20 068 MiB | 1 |
| 32 | 512 / 128 | On, nmax 2 | 32 768 | 152.57 | 37.50 | 214.93 s | 21 486 MiB | 1; 63/63 draft tokens приняты |
| 32 | 2 048 / 512 | Off | 32 768 | **496.06** | 29.36 | **66.21 s** | 20 136 MiB | 1 |
| 32 | 2 048 / 512 | On, nmax 2 | 32 768 | 404.75 | **38.25** | 81.11 s | 21 641 MiB | 1; 63/63 draft tokens приняты |

На одной серии batch/microbatch `1024/256` с 4K prompt prefill составил 220.20 tok/s; `2048/512` — 379.86 tok/s. Для `2048/512` короткий decode был 27.10 tok/s, один запуск. На длинном prompt он поднял prefill до 496 tok/s Off. Больше batch заметно улучшает prefill и TTFT на длинной истории, но сам по себе не улучшил decode в коротком тесте.

При 32K истории MTP ускорил decode с 29.36 до 38.25 tok/s (+30.3%) на `2048/512`, но снизил prefill throughput с 496 до 405 tok/s и увеличил TTFT с 66 до 81 секунды. Для коротких 512-token генераций точная парная серия дала 30.14 tok/s Off и 32.72 On (+8.6%). Это означает, что MTP полезнее при длинной генерации и большой уже обработанной истории; он не ускоряет появление первого токена.

### Flash Attention и KV

Сочетание `cache-type-k=q8_0`, `cache-type-v=q8_0` и `flash-attn=on` загрузилось и отработало на 64K. При `flash-attn=off` эта сборка остановила запуск с точной причиной: `quantized V cache requires flash_attn to be enabled`. Поэтому для Q8 на K **и** V Flash Attention обязателен; отключить его, сохранив этот KV профиль, нельзя.

## Пиковые буферы выбранной конфигурации

Подробный запуск с verbosity 4 напечатал allocations llama.cpp для выбранных `n-gpu-layers=48`, `n-cpu-moe=32`, `ctx=65536`, Q8 K/V, batch 2048/512, MTP nmax 2:

| Буфер | CUDA / host | Размер |
|---|---|---:|
| Основные веса | CUDA0 model buffer | 16 770.23 MiB |
| Основные веса | CPU_Mapped model buffer | 30 603.49 MiB |
| KV основной модели | CUDA0 | 816.00 MiB |
| Recurrent state основной модели | CPU / CUDA0 | 2.09 / 73.28 MiB |
| Compute основной модели | CUDA0 / CUDA_Host | 961.04 / 84.37 MiB |
| MTP draft веса | CUDA0 / CPU_Mapped | 1 264.81 / 166.92 MiB |
| MTP draft KV и compute | CUDA0 KV / CUDA0 compute / CUDA_Host compute | 128 / 104.01 / 72.01 MiB |

Пиковое `nvidia-smi` для этой пары — 21 601 MiB занято, минимум 2 975 MiB свободно; на 32K MTP-прогоне минимум свободной VRAM был 2 935 MiB. Эти totals включают desktop allocations и allocator overhead; не складывайте buffer sizes с показанием `nvidia-smi` как независимые расходы. У коротких замеров с mmap `VmRSS` был около 45 GiB, но доступная системе RAM оставалась примерно 46 GiB и swap counters не росли: file-backed страницы можно reclaim-ить. С `load-mode=none` RSS снизился примерно до 30 GiB, зато доступная RAM упала до 16.5 GiB и скорость не улучшилась.

## Рекомендуемые профили

**Maximum Speed, особенно для длинной истории и продолжительной генерации**

- GPU layers: `48` (в модели 48 блоков; все обычные слои размещаются на RTX 3090).
- CPU MoE layers: `32` (эксперты первых 32 слоёв на CPU, эксперты последних 16 слоёв на GPU).
- Context: `65536`.
- KV K / V: `q8_0` / `q8_0`; KV offload: On.
- CPU threads / batch threads: `8` / `8`.
- Batch / microbatch: `2048` / `512`.
- Flash Attention: On; load mode: mmap; `--fit off`.
- MTP: On через внешний draft, `draft-mtp`, `n-max=2`, draft GPU layers `auto`.
- Reasoning: Backend default; отдельного Thinking toggle у этой модели нет.
- Ожидаемый результат: три коротких прогона 512 tokens дали медиану 32.72 tok/s; при одном 32K prompt decode достиг 38.25 tok/s. Для 32K prompt TTFT был 81.1 s. Пик VRAM 21.6 GiB, резерв по наблюдению около 2.9 GiB.

**Balanced / Desktop Friendly**

- GPU layers: `48`; CPU MoE layers: `36` (на GPU остаются эксперты 12 последних слоёв).
- Context: `65536`; KV K/V `q8_0` / `q8_0`; KV offload On.
- Threads: `8` / `8`; batch/microbatch: `512` / `128`.
- Flash Attention On; mmap; MTP Off; `--fit off`.
- Три коротких прогона дали медиану 29.72 tok/s при пике 16 255 MiB VRAM и около 8.1 GiB свободной VRAM. Это примерно на 2.6% медленнее, чем 32 MoE layers без MTP, но оставляет ещё около 3.7 GiB GPU reserve.

При обеих настройках mmap оставил около 46 GiB доступной RAM; swap на машине отсутствует. 12 потоков снизили скорость и почти полностью загрузили CPU, а 16 потоков не дали завершённого измерения и были остановлены после очень медленного прогрева. Поэтому для отзывчивости системы используйте 8 потоков.

## Как вручную воспроизвести настройки в расширенном режиме Local AI Desktop

### Значения полей

| Поле расширенного профиля | Maximum Speed | Balanced / Desktop Friendly |
|---|---|---|
| GPU layers | `48` | `48` |
| Context | `65536` | `65536` |
| KV cache K / V | `q8_0` / `q8_0` | `q8_0` / `q8_0` |
| KV placement / offload | GPU, `--kv-offload` | GPU, `--kv-offload` |
| Offload mode | Advanced MoE | Advanced MoE |
| CPU MoE | Enabled | Enabled |
| N CPU MoE layers | `32` | `36` |
| Tensor-specific rules | None; `Backend default` | None; `Backend default` |
| CPU threads | `8` | `8` |
| CPU batch threads | `8` | `8` |
| Batch / microbatch | `2048` / `512` | `512` / `128` |
| Flash Attention | `On` | `On` |
| mmap / load mode | `mmap` | `mmap` |
| `--fit` | `off` — не подгонять и не уменьшать заданный контекст | `off` |
| MTP | В UI текущего профиля недоступен для внешнего draft. В прямом llama-server: On, draft `qwen3next`, `n-max=2`, draft GPU layers `auto` | `Off` |
| Reasoning / Thinking | `Backend default`; модель non-thinking | `Backend default`; модель non-thinking |

Профиль хранит 48 GPU layers, а `n-cpu-moe=32` задаёт размещение экспертных весов. Это не значит, что на GPU помещаются только 32 слоя: все 48 основных слоёв видны в логах как offloaded, но MoE experts первых 32 размещены в CPU-mapped буфере.

### Команда Maximum Speed с MTP

Скачайте внешний draft в отдельное место и сначала проверьте его SHA-256. Не заменяйте основную Coder-Next GGUF и не добавляйте draft в её папку:

```bash
curl -fL -o /tmp/Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-Q4_K_M.gguf \
  'https://huggingface.co/a4lg/Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-GGUF/resolve/main/Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-Q4_K_M.gguf'
sha256sum /tmp/Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-Q4_K_M.gguf
```

Ожидаемый hash: `1f7813cd8c944d208183ff81c83de31b82d72dbea5b45d4343ba72c1d37ee4c5`. Если он не совпадает — не запускайте файл.

```bash
export LD_LIBRARY_PATH="/media/yaroslav/DATA/llama.cpp/build-cuda/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server \
  --model '/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/Qwen3-Coder-Next-80B-Q4/Qwen_Qwen3-Coder-Next-Q4_K_M.gguf' \
  --host 127.0.0.1 --port 8080 --no-webui --parallel 1 \
  --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --kv-offload \
  --n-gpu-layers 48 --n-cpu-moe 32 \
  --threads 8 --threads-batch 8 --batch-size 2048 --ubatch-size 512 \
  --flash-attn on --load-mode mmap --fit off \
  --spec-type draft-mtp \
  --spec-draft-model /tmp/Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-Q4_K_M.gguf \
  --spec-draft-n-max 2 --gpu-layers-draft auto --metrics
```

Для MTP Off удалите три `--spec-draft-*` параметра, замените режим на `--spec-type none`; основной GGUF остаётся той же. Для сбора acceptance оставьте `--metrics` и читайте `/metrics`: `spec_decode_num_draft_tokens_total` и `spec_decode_num_accepted_tokens_total` — cumulative counters текущего процесса.

### Команда Balanced / Desktop Friendly

Используйте ту же команду, но замените:

```text
--n-cpu-moe 32        → --n-cpu-moe 36
--batch-size 2048     → --batch-size 512
--ubatch-size 512     → --ubatch-size 128
--spec-type draft-mtp → --spec-type none
```

### Соответствие аргументов и UI

`--n-gpu-layers 48` — поле GPU layers; `--ctx-size` и `--cache-type-k/v` — context и KV. `--n-cpu-moe` выбирает первые N слоёв MoE, чьи experts остаются на CPU; отдельно назначать конкретных экспертов эта сборка не предлагает. Threads, batch, microbatch, Flash Attention и mmap соответствуют одноимённым полям Advanced. Tensor rules оставьте пустыми. `--fit off` нужен, чтобы backend не уменьшил 64K ради памяти.

### Воспроизвести в Local AI Desktop: расширенный профиль

Профиль `Qwen3-Coder-Next 80B Q4 — 64K Q8` проверен через настоящий runtime controller и launcher Local AI Desktop. В редакторе профиля укажите основную и draft GGUF, затем задайте следующие значения. Контекст и MTP Off/On остаются настройками активной сессии; профиль содержит стартовый контекст и проверенный draft.

| Поле UI | Значение |
|---|---|
| Main GGUF | `Qwen_Qwen3-Coder-Next-Q4_K_M.gguf` |
| Projector GGUF | Не используется; оставить пустым |
| MTP / Draft GGUF | `Qwen3-Next-80B-A3B-Instruct-MTP-ONLY-Q4_K_M.gguf` рядом с основной GGUF |
| MTP n-max | `2` |
| GPU layers | `48` |
| Offload mode | `GPU Layers` |
| CPU MoE | `On` |
| N CPU MoE layers | `32` |
| Dense FFN on CPU | `Backend default` / не задавать; это отдельный режим `--n-cpu-ffn`, не CPU MoE |
| Tensor-specific rules | `Backend default` / пусто |
| CPU threads | `8` |
| CPU batch threads | `8` |
| Batch / microbatch | `2048 / 512` |
| Flash Attention | `On` |
| mmap/load mode | `mmap` |
| Context | `65536` (64K), в активной сессии |
| KV K / V | `q8_0 / q8_0` |
| KV placement | `GPU` (`--kv-offload`) |
| MTP session mode | `On` для speculative decoding; `Off` оставляет обычную генерацию |
| Reasoning controls | Не применяются: эта Coder-Next GGUF не подтверждает пользовательский Thinking/effort control |
| Automatic fit | `Off`; не разрешать backend уменьшать заданный контекст или placement |

Существенная часть реально сформированной команды для профиля:

```text
--ctx-size 65536 --gpu-layers 48 --cache-type-k q8_0 --cache-type-v q8_0 --kv-offload
--fit off --n-cpu-moe 32 --threads 8 --threads-batch 8
--batch-size 2048 --ubatch-size 512 --flash-attn on --load-mode mmap
```

Для сессии MTP Off launcher добавляет `--spec-type none` и не передаёт draft. Для On он добавляет `--spec-type draft-mtp --metrics --spec-draft-model <path> --gpu-layers-draft auto --spec-draft-n-max 2`, а для draft KV — `--cache-type-k-draft q8_0 --cache-type-v-draft q8_0`. Эти аргументы записываются в runtime state и сверяются с фактическим `/proc/<pid>/cmdline`.

### Реальная проверка через runtime приложения

После сохранения профиля launcher Local AI Desktop запустил ту же модель сначала с MTP Off, затем безопасно перезагрузил её с внешним draft и MTP On. В обоих режимах `/health` и модель подтвердили контекст 65 536, KV K/V `q8_0`, GPU layers `48`, `--n-cpu-moe 32`; ошибок CUDA OOM не было. Лог Off сообщил `offloaded 48/49 layers to GPU`, а KV cache составил 816 MiB (408 MiB K и 408 MiB V).

Одинаковый smoke-запрос сгенерировал 7 токенов: Off — 22.59 tok/s decode, On — 25.98 tok/s. MTP metrics показали 4/4 принятых draft token (100%) на двух speculative шагах. Это подтверждает загрузку и работу внешнего MTP в приложении, но выборка слишком короткая для benchmark и сравнения с 512-токенными сериями выше. Стабильные скоростные ориентиры остаются результатами предыдущих повторных benchmark: 30.14 tok/s Off и 32.72 tok/s On.

Короткий результат и фактические значения сохранены локально в [`app-runtime-smoke.json`](../test-results/qwen3-coder-next-80b/app-runtime-smoke.json) и `runtime/logs/qwen80b-app-e2e-result.json`, а launcher/server logs — в `runtime/logs/llama-cpp-mtp-*.log`. Перед проверкой сохранена копия прежних runtime logs/state в `runtime/backups/pre-qwen80b-profile-fix-20261020T143813Z/`.

## Выводы и ограничения

- Лучший повторяемый результат на короткой истории: **32.72 tok/s** (512 выходных токенов, MTP On, три повтора). Off при тех же `2048/512` дал 30.14 tok/s.
- Лучшее наблюдение после заполнения половины контекста: **38.25 tok/s** decode при 32K prompt и MTP On, но это один парный запуск; соответствующий Off дал 29.36 tok/s. MTP замедлил prefill и TTFT.
- Воспроизвести 55 tok/s decode не удалось. На этом Q4_K_M, backend и оборудовании подтверждённый устойчивый короткий decode — около 31–33 tok/s; 38.25 tok/s получено один раз после длинного prompt.
- Самый быстрый проверенный `n-cpu-moe` — 32; следующий шаг не исследовался, поскольку MTP-конфигурация уже оставляла около 2.9 GiB свободной VRAM. Это выбранный стабильный предел с резервом, а не утверждение, что значение ниже 32 обязательно не запустится.
- `--flash-attn off` несовместим с Q8 V-cache в этой сборке.
- CPU MoE 32 + MTP требует около 21.6 GiB VRAM total; если другим приложениям нужно больше примерно 3 GiB, используйте Balanced или выключите MTP. Не уменьшайте context автоматически.
- 16-thread тест не завершён; CUDA OOM на выбранных профилях не возникал, поэтому профиль GPU выше 32 CPU MoE и отдельный 14/16/20-layer GPU OOM здесь не проверялись.
- MTP donor сторонний и основан на Qwen3-Next-Instruct; хорошая acceptance этого теста не гарантирует то же для другого sampler, chat history или обновлённой GGUF.
- Приложен отдельный реальный короткий запрос для проверки профиля, но он не является повтором полного benchmark; MTP acceptance/speed из одного короткого ответа не заменяют исходные три повтора по 512 токенов.

## Артефакты измерений

Папка [`docs/test-results/qwen3-coder-next-80b`](../test-results/qwen3-coder-next-80b/) содержит JSON каждого запуска, server logs, фактические `llama-server --help` и `--version`, а также исходные snapshots GPU, CPU и памяти. В JSON есть аргументы, точная команда, повторы, timings, VRAM/RAM/CPU samples и swap counters. 16-thread запуск помечен `interrupted`, Flash Attention Off — `failed` с фактической причиной.

Повторить серию можно runner-ом [`scripts/qwen3-coder-next-80b-benchmark.py`](../../scripts/qwen3-coder-next-80b-benchmark.py). Runner контролирует свободную RAM и VRAM, работает только с переданными путями модели/backend и завершает только созданный им сервер.
