# Launcher offline: живые доказательства, исправление и тесты

Ветка `fix/launcher-offline-cold-start` создана непосредственно от `d0d5137c40eb5a97486a11a948c0908591a8d592`. Long-document изменения сохранены. Release/tag v0.3.0 не менялись.

## Подтверждённый живой сбой

До изменения кода выполнены только read-only проверки процессов, `/proc`, health, control files и журналов. Компактный snapshot: `/tmp/launcher-live-evidence-20261030`; полный пользовательский профиль и секреты в отчёт не переносились.

| UTC, 30 октября | Наблюдение |
|---|---|
| 19:24:59.719 | Прежний Electron завершает runtime shutdown, activeGenerations=0 |
| около 19:25:00 | Launcher 106500 получает нормальный выход прежнего Electron 106538, начинает cleanup сервера 106849 |
| 19:25:01 | Новый launcher 141502 стартует и запускает Electron 141541; его первоначальное состояние idle |
| 19:25:01.702955 | Общий state перезаписан в stopped **старым launcher 106500**, error=`electron exited status=0`; оба PID-файла отсутствуют |
| 19:25:16.547 и 19:25:34.128 | `conversations:update` просит Artemis 57344/q8_0/KV GPU; `switchTo` отказывает примерно за 3 мс до отправки команды |
| 19:28:48.164 | Живой snapshot: Electron 141541, родитель launcher 141502, llama-server отсутствует, health 8081 connection refused |

Непосредственная причина — **гонка cleanup предыдущего launcher и старта следующего**. Старый cleanup без проверки владения удаляет общие PID/request-файлы и пишет stopped поверх нового idle. Новый supervisor при этом жив. UI правильно показывает отсутствие модели; сообщение «launcher не запущен» неверно, потому что controller требовал PID-файл и не находил живого родителя.

Это не выбор неверной операции restart в UI. `switchTo` отправляет единый `ACTION=switch`; shell уже поддерживает cold start, если сервера нет. Ошибка возникает раньше dispatch — на проверке регистрации launcher. IPC сохраняет выбранную активную конфигурацию только после подтверждённого запуска.

## Связь с Artemis-тестами

PID 106849 действительно использовался предыдущими тестами чтения. Но они обращались к существующему backend и не останавливали этот сервер или launcher. Живые журналы показывают **нормальный выход старого Electron и cleanup его штатного родителя**, затем новый штатный запуск. Доказательств тестового orphan server, конфликта временного профиля или изменения runtime-конфигурации нет. Ошибка детерминированно воспроизводится двумя обычными launcher, без LLM и без предыдущих тестов.

## Исправление

- `run-local-ai-desktop-llama-cpp-mtp.sh`: `flock` на весь срок владения каталогом runtime, включая EXIT cleanup. Следующий launcher ждёт завершения cleanup; конкурирующий активный владелец не перезаписывается. Дескриптор lock закрыт для Electron и llama-server, чтобы дети не удерживали lock после смерти supervisor. Cleanup дополнительно отказывается удалять регистрацию successor. Ожидание ограничено.
- Новый `launcher-identity.ts`: проверяет настоящий argv launcher и известный `/proc` start time; ищет PID-файл, валидный state, затем ограниченную цепочку родителей/известного owned child. Не сканирует чужие процессы и не принимает простое упоминание имени скрипта в командной строке.
- `runtime-supervisor.ts`: concurrent ensure использует один Promise. Наследованный `LOCAL_AI_LAUNCHER_MANAGED=1` больше не заменяет проверку живого владельца. При отсутствии владельца создаётся один headless supervisor, изначально idle. Ошибки/таймаут инициализации явные; бесконечного restart нет. Закрытие останавливает только собственный child.
- `llama-runtime-controller.ts`: при Load находит существующего владельца даже с потерянной регистрацией; при настоящем отсутствии вызывает bootstrap, затем обычный switch-протокол. Все запросы по-прежнему сериализованы. Смена конфигурации идёт через прежние проверки/rollback. Мёртвый server/stale state не выдаётся за active; смерть launcher между dispatch и acknowledgement выдаёт конкретную ошибку. Unload ничего не запускает.
- `register-ipc.ts`: подключает bootstrap к production controller. `index.ts`: ошибка supervisor не закрывает окно — UI открывается offline и позволяет явную попытку загрузки.
- `package.json`: команды тестов и зависимость `util-linux` для `flock`.

Crash не запускает модель автоматически: явный Load восстанавливает runtime. Ни `isRunning=true`, ни обход health/profile/PID-проверок не добавлены.

## Проверки

**Детерминированное воспроизведение:** production script из `d0d5137` с задержкой cleanup в тестовой копии теряет state successor (assertion failed). Исправленный script проходит шесть overlapping exit/start подряд. Дополнительно сценарий повторялся несколькими прогонами набора регрессий.

`npm run test:launcher-recovery`: identity/PID reuse/malformed state; cold start с наследованным managed flag; восемь concurrent ensure → один supervisor; потеря регистрации owned child; offline/stale → ready; concurrent switch и смена модели/контекста; server crash/recovery; смерть launcher во время dispatch; bootstrap failure; idle startup без выделения модели; отказ запуска и корректный cleanup. Renderer store: `node scripts/renderer-runtime-status.test.mjs` — реальные изменения state публикуются один раз, device restart сохраняет conversation/features/project/Agent state. TypeScript, typecheck, lint, `git diff --check` проходят.

**Реальный llama-server:** отдельный root `/tmp/lad-launcher-real-gdFDc6`, порт 41025, настоящая Artemis Q4_K_M. GPU предварительно свободна; пользовательский backend не останавливался. Последовательный тест занял 63.652 с:

| Проверка | Результат |
|---|---|
| Stale ready без процессов → 4K q8 GPU | ready за 10.573 с |
| Два concurrent Load той же конфигурации | тот же server PID, без второго процесса |
| Explicit restart | новый PID, 9.034 с |
| 8K f16 KV RAM | ready, 10.038 с; проверены фактические argv context/cache/no-kv-offload |
| Переключение профиля | другой alias того же неизменного GGUF, новый PID, 9.032 с; alias подтверждён `/v1/models` |
| SIGKILL только тестового server → Load | offline → ready, 9.031 с |
| Исполняемый test server с exit 17 | конкретная ошибка до health, offline |
| Восстановление executable → Load | ready, 9.531 с |

Отдельно **точная проблемная конфигурация 56K q8_0 KV GPU** загрузилась из offline за **9.549 с** на том же изолированном профиле. Результаты: `result.json`, `exact-56k-result.json` в указанном root. Был также первый успешный прогон без второго alias; одна попытка расширенного теста отвергнута из-за невалидного тестового ID до старта модели, fixture исправлен на валидный UUID.

Это проверка production supervisor/controller и реального backend; **запущенное пользовательское окно со старым JS не перезагружалось и Load в нём не нажимался**. Pixel/UI-приёмка новой сборки отдельно не выполнялась. Переключение проверено двумя профилями одного GGUF, не двумя разными архитектурами.

## Сохранность и применение

После изолированных тестов Electron 141541 и launcher 141502 всё ещё живы; исходный пользовательский state всё ещё stopped/106500 с тем же mtime `19:25:01.702955Z`, PID-файл отсутствует. Пойманное состояние не потеряно и не ремонтировалось принудительно. SQLite/чаты, настройки, GGUF не менялись; записи тестов находятся в `/tmp`. MoE/CUDA/llama.cpp binary не менялись. Push/merge не выполнялись.

Нужно пересобрать приложение (`npm run build`) и один раз запустить обновлённый экземпляр, поскольку уже открытый процесс держит старые модули. После установки исправления обычный offline/crash восстанавливается кнопкой Load без переключения чатов и перезапуска приложения. Hash commit приведён в итоговом сообщении.
