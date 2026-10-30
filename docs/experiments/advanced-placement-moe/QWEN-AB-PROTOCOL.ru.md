# Qwen A/B protocol: подготовлено, GPU-прогоны ожидают авторизацию

База31eadcd, только Qwen3-Coder-Next80B, backend5047748. Приложение и production runtime не меняются. Прежняя серия16GiB не заменяет paired no-cache quality comparison; новых speedup/quality выводов нет.

## Матрица

scripts/run-qwen-ab.sh: sequential0/8192/12288/16384MiB; одна модель за раз. Для каждой configuration10задач×2цикла; второй цикл reverse order. Все параметры кроме cache budget одинаковы: backend/GGUF, DirectIO/no-repack/no-host/lazy-off, context4096, GPU Q8_0K/V,8threads,batch512/ubatch128, seed42,temp0,chat-template /apply-template, output limit768. Набор scripts/moe-ab-prompts.json сохраняет прежние7задач и добавляет rotateRight, TypeScript lowerBound и exact JSON с проверкой типов.

Первый запрос после загрузки обозначает cold expert cache; последующие запросы уже наследуют cache. Другой порядок во втором цикле не является новым cold start. Hash фактического formatted prompt сохраняется в каждом run. Limiting output768не гарантирует завершённость: stop_type=eos обязателен для automated pass. Следует проверять cache_n=0, реальные token counts, разброс по задачам/циклам. Медиана по разным задачам сама по себе не показывает paired speedup — сравнивать также task-by-task.

ScopeMemoryMax51GiB,MemorySwapMax0; reserve7GiBRAM/2GiBVRAM, прежние guards. До запуска требуется активная авторизованная сессия swappiness0, во время каждого run значение проверяется. На ошибке матрица прекращается. Общий timeout420s на configuration, SIGTERM runner переходит в cleanup. EXIT trap подаёт stop контроллеру и проверяет восстановление по JSON и фактическому sysctl; root controller независимо ограничен1800s. Это не защита от SIGKILL всего дерева/аварии kernel; controller service обеспечивает отдельный lifecycle.

## Оценка

node scripts/evaluate-qwen-ab.mjs читает только сохранённые JSON. Для трёх TS задач strict typecheck и functional cases (empty, negative/large rotations, duplicates, bounds, input immutability); для двух fact задач exact JSON. Output samples выполняются в Node VM с timeout без предоставленных I/O APIs; VM не позиционируется security sandbox. React/Python/explanation/review/conversation помечаются manual-review-required, а не автоматически passed. Pairing по task/repeat, проверка prompt hashes, список новых automated failures. Проверка соблюдения алгоритмической сложности и narrative correctness требует review. Требуется дополнительно сравнить сами тексты и реальные runtime args.

Self-test evaluator прошёл: правильные known answers принимаются, намеренно неправильные lowerBound и exact JSON выявляются как2новые регрессии. 5memory-policy и3restoration tests прошли. Python/shell/JS syntax checks прошли. GPU A/B, long context, MTP и Electron tests ещё НЕ выполнялись в этом продолжении.

## Авторизация

Текущее swappiness60; никаких изменений sysctl в этом продолжении не было. Контроллер расширен optional duration1..1800s (default600), записывает duration и started_unix, сохраняет фактический original до изменения и возвращает его в finally. Пользователю отправлена команда нового уникального systemd unit с duration1800s/RuntimeMaxSec1860. До подтверждения запуска не проводить тяжёлые tests. Пароль в чат не передаётся.

После основной A/B серии root session закрывается. Long-context4K/16K/64K и MTP требуют следующего контролируемого окна и проходят только после анализа quality. Не выдавать истечение окна/отсутствие root как техническую несовместимость модели.
