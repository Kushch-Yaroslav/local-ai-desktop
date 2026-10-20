# GPT-OSS-120B Q4_K_M на RTX 3090: подтверждённый базовый профиль

Этот документ фиксирует текущий реальный замер и безопасную отправную точку, но не объявляет поиск максимальной скорости завершённым. После первого baseline дальнейшие профилирования были остановлены автоматической проверкой из-за swap activity; дополнительные запуски требуют отдельного разрешения.

## Оборудование и модель

- NVIDIA GeForce RTX 3090, 24 GiB; AMD Ryzen 7 5700X3D, 8C/16T; 64 GiB DDR4; Linux.
- Backend: `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`, версия `0.4.1-dev`, commit `d1d3c33`, CUDA build.
- Фактическая модель — GPT-OSS-120B, `gpt-oss` architecture, 36 блоков, 128 experts / 4 active, trained context 131 072, Harmony template, split Q4_K_M из двух GGUF общим размером около 62.9 GB.
- Использовались обе части split-файла из сохранённого профиля. Файлы не менялись.

GGUF metadata не содержит `nextn_predict_layers` или MTP/NextN тензоров. В каталоге этой модели отдельный MTP/draft GGUF не найден. Backend умеет флаг `--spec-type draft-mtp`, но одного флага недостаточно: совместимые веса для GPT-OSS не подтверждены. Поэтому MTP оставлен Off; использовать Qwen sidecar для GPT-OSS нельзя.

## Реальный baseline

Измерение выполнил изолированный runner, который запускал и завершал только собственный llama-server. Контекст — 32 768, K/V Q8, GPU layers 12, CPU MoE 0, 8/8 threads, batch/microbatch 512/256, Flash Attention Auto, mmap. Одинаковый prompt — 59 токенов, два повтора по 128 output tokens.

| Повтор | Prompt processing | TTFT | Decode | Output |
|---:|---:|---:|---:|---:|
| 1 | 5.43 tok/s | 11.07 s | 11.94 tok/s | 128 tokens |
| 2 | 18.63 tok/s | 7.96 s | 15.25 tok/s | 128 tokens |
| Median | 12.03 tok/s | 9.51 s | **13.60 tok/s** | — |

Показатели сильно различались между повторами, поэтому их нельзя считать точным или стандартизированным benchmark. Runner зафиксировал максимум 20 598 MiB занятой VRAM, минимум 3 978 MiB свободной VRAM, peak RSS 54.43 GiB, минимум доступной системной памяти 52.34 GiB и swap counters 190 127 pages in / 1 182 124 pages out за 65 samples. После завершения server-процесс отсутствовал. При штатной очистке runner дождался SIGTERM 25 секунд и затем завершил только созданный им процесс сигналом KILL; это ограничение shutdown также требует внимания перед более широким перебором.

Ранее сохранённый реальный GPT-OSS runtime regression подтверждает запуск на 12 GPU layers и 32K Q8, работу tool calling/Harmony и rollback после реальной CUDA allocation failure. Результат есть в [`gptoss-run.log`](../test-results/model-profiles-v2/gptoss-run.log). Другая историческая запись фиксирует CUDA OOM на 14 слоях при резервировании 651.30 MiB compute buffer; это конкретная allocation failure, а не доказательство fragmentation.

## Профиль Local AI Desktop

Сохранён как дополнительный runtime-профиль **GPT-OSS-120B Q4 — 12 GPU / 32K Q8**. Исходный GPT-OSS-профиль с 13 GPU layers сохранён без изменений и остаётся экспериментальным. Новый профиль прошёл сохранение и чтение обратно из runtime settings; реальный Electron Load для этого нового profile ID в этом этапе не выполнялся.

| Поле расширенного режима | Значение |
|---|---|
| Main GGUF | Существующий GPT-OSS-120B Q4_K_M split, part 1; part 2 должна находиться рядом |
| Projector | `Backend default` / пусто |
| MTP / Draft GGUF | `Backend default` / пусто; MTP Off |
| GPU layers | `12` |
| Offload mode | `GPU Layers`, `--fit off` |
| CPU MoE | `Off` |
| N CPU MoE layers | `Backend default`; не задавать |
| Dense FFN on CPU | `Backend default`; не задавать |
| Tensor-specific rules | `Backend default`; список пуст |
| CPU threads / batch threads | `8 / 8` |
| Batch / microbatch | `512 / 256` |
| Flash Attention | `Auto` |
| mmap/load mode | `mmap` |
| Session context | `32768` |
| KV K / V | `q8_0 / q8_0` |
| KV placement | `GPU`, `--kv-offload` |
| MTP n-max | `Backend default` / неприменимо |
| Reasoning | Effort выбирается в панели сессии; Low/Medium/High не требуют перезапуска server |
| Sampling | `Backend default`; задаётся запросом сессии |

Низкоуровневая команда сопоставимого baseline:

```bash
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server \
  --model '/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/gpt-oss-120b-Q4_K_M/openai_gpt-oss-120b-Q4_K_M/openai_gpt-oss-120b-Q4_K_M-00001-of-00002.gguf' \
  --host 127.0.0.1 --port 8080 --ctx-size 32768 \
  --cache-type-k q8_0 --cache-type-v q8_0 --kv-offload \
  --n-gpu-layers 12 --n-cpu-moe 0 \
  --threads 8 --threads-batch 8 --batch-size 512 --ubatch-size 256 \
  --flash-attn auto --load-mode mmap --fit off --parallel 1 \
  --jinja --reasoning on --reasoning-format auto --spec-type none
```

Профиль приложения для режима CPU MoE Off не передаёт `--n-cpu-moe`; отсутствие флага означает обычное размещение по GPU layers. Baseline runner передавал `--n-cpu-moe 0` явно. Эти два варианта соответствуют выключенному CPU MoE.

## Что пока не измерено

CPU MoE 28, GPU layers 13 и 14, 12/16 CPU threads, batch/microbatch alternatives, Flash Attention On против Auto и MTP с совместимым draft не тестировались в этой серии. Следующий запуск 12-layer CPU MoE был отклонён автоматической проверкой после первого замера из-за высокой системной swap activity; обходить это решение нельзя. Поэтому **13 слоёв пока остаются экспериментальными**, а стабильная рекомендация ограничена 12 слоями.

Реальное доказательство tool calling/Harmony из предыдущего приложения-теста доступно в указанном выше журнале. Новый baseline измерял обычную генерацию, а не agent tools.

## Сырые результаты

Полный JSON с точным argv, обоими ответами, timings и системными samples сохранён в [результате baseline](../test-results/gpt-oss-120b/12gpu-no-cpumoe-8t/20261020T150230Z-ngl12-ncmoe0-t8-tb8-b512-ub256.json) и рядом в server log. В JSON указан exit code `-9` после ограниченного cleanup timeout, несмотря на успешно завершённые запросы; это отражено как shutdown limitation, а не успешный graceful exit.
