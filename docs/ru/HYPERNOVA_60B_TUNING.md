# HyperNova 60B Q4: установка и профиль 64K Q8

## Модель и файл

- Исходный checkpoint: [`MultiverseComputingCAI/HyperNova-60B`](https://huggingface.co/MultiverseComputingCAI/HyperNova-60B).
- GGUF: [`mradermacher/HyperNova-60B-i1-GGUF`](https://huggingface.co/mradermacher/HyperNova-60B-i1-GGUF), файл `HyperNova-60B.i1-Q4_K_M.gguf`.
- Зафиксированная ревизия GGUF-репозитория: `191e9b22574e33fa9a6bc7690f9174cdf09e642e`.
- Размер: 40 687 403 680 байт.
- SHA-256: `37a47f03fc1670f0b962939c100811a85cfcb58c81960960c17e4b0d8bf8f6c2`.
- Путь установки: `/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/HyperNova-60B-Q4/HyperNova-60B.i1-Q4_K_M.gguf`.
- GGUF metadata: архитектура `gpt-oss`, размерная метка 60B, 32 блока, 80 экспертов, 4 активных эксперта, обучающий контекст 131 072, тип `Q4_K_M`.
- GGUF указывает исходный checkpoint `openai/gpt-oss-120b`; это HyperNova 60B адаптация, а не исходный GPT-OSS-120B.
- Tokenizer: GPT-2 / `gpt-4o` pre-tokenizer. Шаблон — GPT-OSS Harmony.

Семейство профиля — GPT-OSS. В шаблоне обнаружены уровни reasoning Low / Medium / High; они передаются в запросе как `reasoning_effort`, без перезапуска backend. Reasoning-поле возвращалось отдельно от final-content. GGUF-шаблон содержит описание инструментов, однако короткая проверка `echo_value` вернула обычный текст с JSON вместо структурированного `tool_calls`; надёжный tool calling этим тестом **не подтверждён**.

Vision не подтверждён: файл не содержит projector, а мультимодальный путь для этого GGUF не обнаружен. Вложенный MTP/NextN не найден: в GGUF нет соответствующих тензоров или `nextn_predict_layers`. Проверка MTP On через приложение завершилась диагностикой `MTP On unavailable: Embedded MTP is not validated for architecture gpt-oss.` Совместимый MTP sidecar не найден и не подключался. MTP Off — единственный проверенный режим.

## Оборудование и backend

- GPU: NVIDIA RTX 3090, 24 ГиБ.
- CPU: AMD Ryzen 7 5700X3D, 8 ядер / 16 потоков.
- RAM: 64 ГиБ DDR4.
- Backend: llama.cpp `0.4.1-dev`, commit `d1d3c3396aa13a5f239109a822666c4870490ad5`, сборка от 2026-09-15 с CUDA.
- Тест выполнен через launcher Local AI Desktop и `LlamaRuntimeController` в отдельном временном runtime; пользовательское окно Electron не запускалось.

## Наблюдения smoke-тестов

Все замеры — отдельные короткие прогоны, не стандартизированный benchmark и без повторов. Контекст сервера был установлен в 65 536; это не означает, что каждый запрос заполнял весь контекст.

| GPU layers | Prompt | Prompt processing | Decode | VRAM после загрузки | Результат |
|---:|---:|---:|---:|---:|---|
| 8 | 78 токенов | 29,66 ток/с | 16,20 ток/с | 11 207 МиБ занято | корректный короткий текстовый ответ; MTP Off |
| 12 | 142 токена | 52,30 ток/с | 17,03 ток/с | около 16 015 МиБ занято | ответ пришёл, но тестовое требование tool call модель вывела обычным текстом |
| 16 | 90 токенов | 48,75 ток/с | 20,49 ток/с | 20 739 МиБ занято, 3 380 МиБ свободно | корректный текстовый ответ; MTP Off |
| 16 | 7 581 токен | 131,63 ток/с | 13,11 ток/с | около 20 809 МиБ занято | длинный prompt обработан; ответ ограничен 24 выходными токенами |

При 16 слоях backend сообщил CUDA buffers: model 18 389 МиБ, KV/context около 545 МиБ и compute 554 МиБ; ещё примерно 1 318 МиБ оставались нераспределённым резервом устройства. На host: model 20 400 МиБ, context 546 МиБ, compute 18 МиБ. При 12 слоях снимок backend показывал около 8 075 МиБ свободной VRAM против около 3 309 МиБ при 16 слоях. Swap в начале проверки уже был занят примерно на 4,1 из 8 ГиБ; его изменение или очистка не выполнялись. Эти снимки не являются точным измерением пикового RSS процесса.

Reasoning Effort High действительно сформировал `reasoning_content`, но запрос был ограничен 96 выходными токенами и не успел закончить final-ответ. Короткий запрос Low завершился корректным текстом. Для настоящего Agent Run и tool calling требуются отдельные тесты.

## Рекомендуемая конфигурация

**Рабочий / Desktop-friendly профиль:** 12 GPU layers, 64K Q8. Он загрузился с запасом около 8 ГиБ VRAM. Измеренная короткая скорость decode была около 17 ток/с, а не 30 ток/с.

**Экспериментальный максимум:** 16 GPU layers. В коротком запросе получено 20,49 ток/с, однако свободно оставалось около 3,3 ГиБ VRAM. Для обычной работы с Electron, Chromium и другими GPU-процессами этот вариант не рекомендуется без повторного теста на машине пользователя.

Значение 30 ток/с не достигнуто. Длинный запрос из 7 581 входного токена показал 13,11 decode ток/с; скорость короткого prompt не переносится на длинную историю. CPU MoE, tensor overrides, другие batch-параметры и MTP не сравнивались, поэтому документ не объявляет конфигурацию глобально оптимальной.

## Настройки в расширенном режиме Local AI Desktop

Профиль `HyperNova 60B Q4 — 64K Q8` добавлен в пользовательский `runtime-settings.json`. Применённый рабочий набор:

| Поле | Значение |
|---|---|
| Основной GGUF | `/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/HyperNova-60B-Q4/HyperNova-60B.i1-Q4_K_M.gguf` |
| Семейство | GPT-OSS |
| GPU layers | 12 |
| Контекст сессии | 65 536 |
| KV K / V | `q8_0` / `q8_0` |
| KV placement | GPU |
| Offload mode | GPU Layers; `--fit off` |
| CPU MoE | Off; `--cpu-moe` не передаётся |
| N CPU MoE layers | 0 / не применяется |
| Dense FFN on CPU | Backend default |
| Tensor rules | Backend default |
| CPU threads | 8 |
| CPU batch threads | 8 |
| Batch / microbatch | 512 / 128 |
| Flash Attention | On |
| mmap / load mode | mmap |
| MTP | Off; совместимые MTP-веса не обнаружены |
| Projector / Vision | отсутствует / не подтверждено |
| Reasoning | Medium default; Low / Medium / High управляются в сессии |
| Tool calling | GGUF template auto-detect; структурированный вызов не подтверждён smoke-тестом |

Для ручного воспроизведения начните с 12 GPU layers. Не включайте MTP и не добавляйте случайный draft-файл. Чтобы проверить 16 слоёв, учитывайте малый резерв VRAM и сохраните рабочее значение 12 для отката.

## Фактическая команда llama-server

Команду сформировал launcher Local AI Desktop; значения ниже относятся к успешному профилю с 12 слоями и MTP Off:

```bash
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server \
  --log-verbosity 5 \
  -m '/media/yaroslav/01D9B3596C5596B0/LINUX-LLM/HyperNova-60B-Q4/HyperNova-60B.i1-Q4_K_M.gguf' \
  --alias 'custom:560bdb38-378c-4d96-a068-c0341a2df821' \
  --host 127.0.0.1 --port 18081 \
  --ctx-size 65536 --gpu-layers 12 \
  --cache-type-k q8_0 --cache-type-v q8_0 --kv-offload \
  --parallel 1 --jinja --reasoning on --reasoning-format auto \
  --fit off --threads 8 --threads-batch 8 \
  --batch-size 512 --ubatch-size 128 \
  --flash-attn on --load-mode mmap --no-warmup --spec-type none
```

Указанный alias и порт принадлежат временному интеграционному тесту; при самостоятельном запуске их можно заменить. Для повторяемости важны остальные параметры и абсолютный путь к установленному GGUF.

## Ограничения

- Это smoke-проверки, а не сравнительный benchmark; нет нескольких повторов и полного Agent Run.
- MTP отсутствует и не ускоряет эту модель в проверенной конфигурации.
- Vision и надёжный structured tool calling не подтверждены.
- 64K context был реально передан launcher и принят сервером, но длинный тест занял только 7 581 входной токен.
- Скорость 30 ток/с не подтверждена; стабильный профиль показал около 17 ток/с на коротком запросе.
