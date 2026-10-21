# Comet 60B A12B Q4: состояние совместимости и запуск 64K Q8

## Результат проверки

Это экспериментальная конверсия, а не готовый профиль для Agent Mode. Текущий llama.cpp загружает её с MTP Off при контексте 65 536 и Q8 K/V, однако контрольный запрос с выключенным thinking вернул пустое поле `content` после 16 сгенерированных токенов. Корректный видимый ответ и вызов инструмента через Agent Runtime не подтверждены, поэтому пользовательский профиль Comet не добавлен. Скорость ниже комфортного ориентира 30 ток/с.

MTP-веса присутствуют в исходном checkpoint и GGUF metadata (`nextn_predict_layers=1`), но MTP On не работает в текущей сборке. Реальный `llama-server` падает в MTP graph с `GGML_ASSERT(as->ne[0] == b->ne[0])` из `llm_graph_context::build_moe_ffn` / `llama_model_nemotron_h_moe::graph_mtp`. Acceptance и MTP speedup не измерены. Включать MTP нельзя.

## Модель и происхождение файла

- Исходный checkpoint: [MultiverseComputingCAI/Comet_60B_A12B_BF16](https://huggingface.co/MultiverseComputingCAI/Comet_60B_A12B_BF16), revision `aeb47274de040bc631622b0dd470944ba3cfa3cd`.
- Это гибридная Nemotron-H / Mamba2 + Transformer MoE модель: 88 основных блоков и один MTP-блок, 256 экспертов / 22 активных. Это не NVFP4, FP8 или MLX quant.
- Официальный репозиторий содержит BF16 safetensors, но готовый официальный GGUF Q4_K_M или совместимый отдельный MTP-only sidecar не найден.
- Локальный GGUF конвертирован из BF16 checkpoint текущим конвертером llama.cpp, затем `llama-quantize` Q4_K_M. На выходе 5.65 bpw; 41 из 781 тензоров получили fallback quantization. Поэтому `Q4_K_M` обозначает тип выходного файла llama.cpp, а не vendor-qualified quantization.
- В конвертере текущей сборки отсутствовал metadata key для `layer_norm_epsilon=1e-5`; при генерации исходного GGUF применён явный override `--override-kv nemotron_h_moe.attention.layer_norm_rms_epsilon=float:0.00001`.
- Первичная конверсия содержала 781 тензор и не загружалась: backend ожидал 779. В проверенный файл оставлены те же данные, кроме двух MTP-блочных latent projections `blk.88.ffn_latent_down.weight` и `blk.88.ffn_latent_up.weight`, которые текущий loader не потребляет. Файл всё ещё сохраняет встроенные MTP metadata и остальные MTP-тензоры; это не делает MTP совместимым.
- Файл: `/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/Comet-60B-Q4/Comet_60B_A12B_Q4_K_M.gguf`.
- Размер: `42 615 354 528` байт. SHA-256: `b35388affe0c8d5f3a6bcc235830292691ad0e059bce0587063ea526888ec62f`.
- Полный исходный BF16 checkpoint сохранён в `.source-bf16` рядом с GGUF для воспроизводимости конверсии. Временный полный BF16 GGUF удалён после конверсии; исходные safetensors не изменялись.

## Архитектура, шаблон и возможности

GGUF сообщает архитектуру `nemotron_h_moe`, 256 experts, 22 active experts, 89 блоков GGUF (88 основных и один MTP), обучающий контекст 1 048 576. Приложение определяет семейство как `Custom`; ручной выбор другого семейства не должен менять capabilities.

В шаблоне есть `enable_thinking`; UI может предложить Thinking On/Off для этой конверсии после проверки реального ответа. Проверка здесь подтвердила только обнаружение переключателя в шаблоне, но не успешное разделение reasoning/final. Отдельные уровни Reasoning Effort не обнаружены.

Model card заявляет tool calling и мультимодальность исходного checkpoint. Этот GGUF экспортирован как текстовая модель без проверенного multimodal tower/projector: Vision для данного файла недоступен. Tool calling не проверен корректным вызовом в Agent Runtime и не должен включаться как подтверждённая возможность.

## Backend и реальный smoke test

- llama.cpp `0.4.1-dev`, commit `d1d3c3396aa13a5f239109a822666c4870490ad5`, CUDA build от 2026-09-15.
- Local AI Desktop launcher и настоящий `LlamaRuntimeController`; данные теста размещались в отдельном `/tmp/lad-comet-*` runtime.
- GPU: RTX 3090 24 ГБ; CPU: Ryzen 7 5700X3D; RAM: 64 ГБ.
- Загрузка MTP Off прошла без CUDA OOM: `n_ctx=65536`, KV K=`q8_0`, V=`q8_0`, GPU offload `16/90` слоёв, `--fit off`.
- Короткий однократный замер: prompt 37 токенов, prompt processing `13.87 tok/s`, decode `4.31 tok/s`, 96 выходных токенов. Ответ не завершился корректным видимым содержимым; это не подтверждение качества генерации и не benchmark.
- Второй запрос с thinking Off принял 16 выходных токенов и снова вернул `content: ""` с `finish_reason=length`; prompt 26 токенов, `12.995 tok/s`, decode `4.261 tok/s`. Это scripted HTTP request через реальный backend, не Agent Runtime tool test.
- При MTP Off: backend log сообщил CPU-mapped model buffer `31 838 MiB`, CUDA model buffer `7 739 MiB`, CUDA compute `1 040 MiB`, CUDA context `58 MiB`, CPU context/recurrent около `377 MiB`, CPU compute `41 MiB`. Снимок `nvidia-smi` достигал примерно `10 080 MiB` общей занятой VRAM. Это единичное наблюдение, не peak RSS или benchmark.
- Attention KV K/V действительно запрошены как Q8. Гибридное recurrent state не становится Q8: llama.cpp сообщил суммарный recurrent buffer около `164.69 MiB` в одном запуске, с F32 state. Не считать Q8 настройкой всех внутренних состояний.
- MTP On с `--spec-type draft-mtp --spec-draft-n-max 2` загружал draft context, затем процесс завершился с assertion формы MoE; acceptance counters отсутствуют. На этом backend MTP несовместим с данной конверсией.
- `supportsTools` не подтверждён; `read_file` Agent Runtime тест не завершён успешно. Сохранённый профиль намеренно не создан.

## Команда, использованная для загрузки без MTP

Это команда из тестового launcher. Alias и порт временные.

```bash
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server \
  --log-verbosity 5 \
  -m '/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/Comet-60B-Q4/Comet_60B_A12B_Q4_K_M.gguf' \
  --alias comet-experimental --host 127.0.0.1 --port 42873 \
  --ctx-size 65536 --gpu-layers 16 \
  --cache-type-k q8_0 --cache-type-v q8_0 --kv-offload \
  --parallel 1 --jinja --reasoning on --reasoning-format auto \
  --fit off --threads 8 --threads-batch 8 \
  --batch-size 512 --ubatch-size 128 \
  --flash-attn on --load-mode mmap --no-warmup --spec-type none
```

## Как вручную воспроизвести настройки в расширенном режиме Local AI Desktop

Пока не добавляйте этот файл как рабочий профиль, если ожидается готовый чат или Agent Mode. Для исследовательской проверки в редакторе GGUF значения такие:

| Поле | Значение |
|---|---|
| Основной GGUF | путь выше; профиль не сохранён |
| Семейство | Auto / Custom; family override не меняет backend capabilities |
| GPU layers | 16 в проверочном запуске; не оптимизировано |
| CPU MoE | Backend default / Off |
| N CPU MoE layers | Backend default |
| Dense FFN on CPU | Backend default |
| Tensor-specific rules | Backend default |
| CPU threads / batch threads | 8 / 8 |
| Batch / microbatch | 512 / 128 |
| Context | 65 536, Automatic Fit Off |
| KV K / V | `q8_0` / `q8_0` |
| KV placement | GPU для attention KV; recurrent state остаётся F32 |
| Flash Attention | On |
| mmap / load mode | mmap |
| MTP | Off; MTP On завершился backend assertion |
| MTP draft GGUF / n-max | отсутствует / не применяется; sidecar не скачивался |
| Vision / projector | Off / отсутствует для text-only GGUF |
| Thinking | шаблон содержит toggle, но visible response не подтверждён |
| Reasoning effort | Backend default; уровни не обнаружены |
| Tool calling | Не подтверждено; не включать как рабочую возможность |

## Ограничения и сравнение

| Модель | Контекст / KV | MTP | Decode | Статус |
|---|---|---|---:|---|
| HyperNova 60B Q4 | 64K / Q8 | Не найдено совместимых MTP-весов | 16.20–20.49 tok/s в коротких отдельных smoke-запусках | Загружается; пользовательский профиль сохранён; tool calling и Vision не подтверждены |
| Comet 60B A12B Q4 | 64K / Q8 attention cache | Embedded metadata есть, backend MTP падает | около 4.3 tok/s, единичный короткий замер | GGUF загружается MTP Off, но видимый ответ и tool calling не подтверждены; профиль не сохранён |
| Qwen3-Coder-Next 80B Q4 | 64K / Q8 | Внешний проверенный draft ранее работал | около 30–33 tok/s ранее | Исторический результат, не измерялся в этой задаче |

30 tok/s для Comet не достигнуты. Для рабочего интерактивного Agent Mode сейчас следует использовать HyperNova-профиль только для обычного чата с учётом его документированных ограничений; Comet оставить экспериментом до исправления конвертера/backend graph и подтверждения видимого ответа и tools.
