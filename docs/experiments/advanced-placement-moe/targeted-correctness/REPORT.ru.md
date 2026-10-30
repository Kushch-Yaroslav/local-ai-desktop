# Qwen targeted correctness: результат C, причина ещё не доказана полностью

UI, GPT-OSS, MTP и новые performance suites не запускались. Backend5047748 и production runtime не модифицировались. Использован отдельный явный LD_PRELOAD probe с публичными llama/ggml API. Он возвращает исходный raw-logit pointer, не меняет logits/sampler. Модель/GGUF только читались. Swappiness остался60 во всех тестах; новая авторизация sysctl не потребовалась. Cgroup51GiB/swap0, прежний watchdog: во всех полноразмерных запусках swap-out0, net swap growth0, OOM0. GPU освобождена после тестов.

## Воспроизведение и точный prompt

Взят точный explain task из scripts/moe-ab-prompts.json. Formatted prompt hash проверен против сохранённого A/B. Input IDs сохранены в reference.json и побайтово одинаковы в обоих режимах. После нового старта baseline/cache16GiB получены два полных ответа в каждом режиме: они совпали между повторениями и совпали с соответствующими прежними A/B outputs. Baseline снова корректен; cache снова утверждает−2 для пути2+(-3), хотя правильный результат−1. Это отдельно от корректности применения Dijkstra к отрицательным рёбрам.

Ограничение cold/warm: native llama.cpp startup warmup оставлен как в A/B, поэтому первый запрос не гарантирует буквально пустой expert cache. Второй free request следует после teacher probes, а не только после первого free. Это restart/разная cache history, не строгий zero-filled cold-cache test.

## Первое расхождение и raw logits

Свободная генерация впервые расходится на шаге20 (zero-based): token5278 `known` против3231 `current`. Все предыдущие20output IDs одинаковы. Сохранены32raw vectors; сравнивались лишь позиции0..20 включительно. После дивергенции logits разных префиксов НЕ сравнивались.

На последнем общем префиксе:

| Token | CPU logit | Cache logit | CPU probability | Cache probability | CPU/cache rank |
|---|---:|---:|---:|---:|---|
| known5278 |22.009823|21.839600|0.415899|0.367917|1/2|
| current3231 |21.902718|21.948858|0.373657|0.410394|2/1|

CPU top2 gap0.107105, cache gap0.109259. Raw max absolute error0.417439; MAE0.051057; total variation0.049873; Jensen–Shannon0.001326nats. Probabilities — обычный softmax raw logits, не post-sampler distribution. Уже на первом free step max error0.237842, MAE0.042821; его распределение резко концентрировано, TV≈2.68e-8 и chosen token совпадает.

Teacher-forced:16identical input prefixes, каждый содержит baseline output IDs до позиции0..15 и предсказывает1токен. Каждая пара имеет одинаковые IDs и batching. Full vocabulary151936. Max absolute error по шагам0.213119–0.868007, MAE0.035115–0.096783, norm-relativeL1 1.21–4.35%. Нет нестабильных elementwise-relative ratios возле нуля.

Первое teacher top1 disagreement — шаг15: token353 против2436; CPU logits19.389128/19.339546, cache19.084635/19.342739. CPU gap0.049582. Teacher batching — повторный prefill; он отличается от incremental free decoding, поэтому teacher15 и free20 не являются одной и той же точкой. В raw comparison нет смешения префиксов после дивергенции. Полные агрегаты/top10union/ranks в logits.json. Raw binaries временные, в Git не добавлялись.

## Контролируемые реальные expert tensors

Из GGUF descriptors прочитано только по одному expert0: Q4_K blk.0.ffn_gate_exps.weight [2048,512] и Q6_K blk.0.ffn_down_exps.weight [512,2048]. Для одинакового детерминированного входа выполнен реальный ggml_mul_mat_id в трёх режимах: CPU static, CUDA static, CUDA slot1 с перезаписью прежнего содержимого. Payload не коммитится, extraction script сохранён.

| Tensor | CPU/CUDA max abs | CPU/CUDA mean abs | CUDA static/slot max abs | Полные bytes expert |
|---|---:|---:|---:|---|
| Q4_K |0.000687689|0.000059203|0|совпали|
| Q6_K |0.000461701|0.000079958|0|совпали|

Локально CPU/CUDA arithmetic различается при одинаковых весах. Статический CUDA и slot CUDA bitwise-equivalent на этих inputs. Это реальное контролируемое свидетельство, но оно НЕ доказывает, что все полные model-level различия объясняются только арифметикой. Тест использует явный sync для read-back и не является race stress test. MXFP4 не тестировался: Qwen экспертные groups используют Q4_K/Q6_K, GPT не загружался.

## Slots и реальные передачи

Ранее actual SLRU struct прошёл20000requests/944705identity checks; повторять полную прежнюю проверку не требовалось. Проверены offsets/stride в маленьком CUDA контроле: expert bytes равныnb[2], slot offset=id*nb[2]; full read-back совпал после overwrite. В полном cache probe выбранные512-byte блоки начала/середины/конца actual uploads сравнивались с CPU source snapshots после существующих sync. Выборка не исключает повреждения несэмплированных байтов.

Первый завершённый expert-only probe:417blocks, errors0,pending0. После усиления фильтра до GPU-only финальный повтор:270blocks, errors0,pending0; HTTP request истёк по40s timeout, сервер завершён. Этот последний повтор НЕ считается полным cold/warm или logits comparison. Сохранённые logits/ответы относятся к предыдущему завершённому прогону. Capture manifest/session guard предотвращает смешение partial files со старыми результатами.

Негативный контроль: намеренно изменён байт отдельного приватного CUDA slot. Probe выдал LAD_TRANSFER_MISMATCH offset589824 и expected SIGABRT134. Положительный контроль:uploads3/blocks9/errors0/pending0. До этих controls исправлены ошибки самого probe: изменяемые slot_map ошибочно попадали в weight filter; CPU tensors сохранялись в pending samples после завершения их lifetime в микро-контроле. Это диагностические ошибки, НЕ подтверждённые backend bugs. Исходники backend не патчились.

Read-back выполняется после штатных sync, но задержки диагностического инструмента меняют timing и могут скрывать races. Полный final probe заметно замедлил запрос и превысил timeout; точная причина overhead отдельно не установлена. Не переносить его timing на production performance. Нельзя считать sampled read-back доказательством отсутствия всех async bugs.

## Вывод и минимальная следующая проверка

Подтверждено: арифметические отличия CPU/CUDA на двух фактических expert tensors; отсутствие отличий static-CUDA/slot-CUDA в контроле; отсутствие byte mismatch в sampled model transfers; переворот близких конкурирующих logits на идентичном model prefix.

Не доказано: что исключительно CPU/CUDA arithmetic объясняет весь model-level logit delta и ошибочный итоговый текст; что нет timing-sensitive cache bug. Это C с существенными инструментальными данными в пользу численного объяснения, а не завершённый B.

Минимальный следующий причинный тест: захватить одинаковые input activations/selected expert IDs внутри первого расходящегося MoE operation, повторить этот exact operation CPU/static CUDA/cache CUDA, сравнить outputs до downstream accumulation. Включить проверку slot bytes именно на этом operation и контроль без perturbing read-back. Так можно отделить propagation CPU/CUDA ошибки от ошибочной slot/copy/sync. Полное staticGPU размещение45GiB модели на24GiB не пытались делать.

Исправлений backend нет, заявленного исправления ошибки нет. Новые speed benchmarks не проводились; incidental timings инструментированных запросов не используются как performance evidence. Продвижение функции как проверенной в Local AI Desktop пока не обосновано; UI/production не менялись.

Тесты:3unit tests logit metrics (identity, additive shift, ranking),2малых actual-tensor controls, positive/negative upload checks; Python syntax checks проходят. Источники в scripts/moe-diagnostics. Все диагностические сбои/таймауты сохранены, не скрыты.
