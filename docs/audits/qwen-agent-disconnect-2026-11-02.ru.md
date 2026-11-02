# Повторный обрыв Qwen Agent V2, 2026-11-02

## Установленные факты

Исходный HEAD: `6d11fcd`, ветка `feature/advanced-placement-moe-acceleration`.
Источники: `runtime/logs/application.log`, `llama-cpp-mtp-launcher.log`,
`llama-cpp-mtp-server.log`. Содержимое пользовательских запросов и исходников
в этот отчёт не копируется.

- Run `0df69402-ae3a-4dc9-a213-37a59ba9d76c`, conversation
  `a67d8410-d1a4-4156-a04a-c9992bede430`, Rust worker PID 7100.
- Agent submission: 14:10:58.874 UTC. Сервер PID 6113 запущен 14:09:14 UTC,
  ready 14:09:45 UTC. Профиль Qwen: cache 16384 MiB, 65536 Q8 GPU KV,
  CPU MoE, mmap, MTP off. `--moe-cache-mib` действительно присутствует.
- Последнее успешное чтение: `docs/en/MODELS.md`, observation 22.
  Следующее чтение `third_party_notices.md` (именно нижний регистр)
  вернуло FILE_NOT_FOUND, observation 23. Это штатный результат инструмента,
  не транспортная ошибка и не доказанное чтение `THIRD_PARTY_NOTICES.md`.
- Последний завершённый inference: task 972, prompt 51903 токена,
  генерация 39 токенов. Следующий task 1021 получен в относительное время
  10:15.891922 после старта процесса (приблизительно 14:19:29.9 UTC).
- Для task 1021 backend сообщает LCP 17194 / `task.tokens.size()` 34177.
  Этот знаменатель проверен по исходнику server-context.cpp: это размер
  нового tokenized prompt. Последний запрос не был заполненным 64K.
  При смене префикса сохранено предыдущее состояние 51941 токена,
  размер 722.697 MiB. Лимит RAM prompt cache по умолчанию 8192 MiB;
  наличие лимита не означает фактического выделения всего этого объёма.
- 14:19:31 UTC: launcher инициировал SIGTERM PID 6113.
- 14:19:41 UTC: launcher отправил SIGKILL тому же PID.
- 14:19:43.745 UTC: Rust сообщил `HTTP status: upstream closed while reading HTTP framing`.
  Здесь EOF возник при ожидании HTTP status следующего inference, а не
  после успешного завершения SSE и не между двумя выполнениями инструмента.
- Launcher в ту же секунду записал memory safety stop. Снятые перед остановкой
  счётчики: MemAvailable 51527096 KiB = 49.140 GiB;
  прирост pswpout 13972 страницы × 4096 = **54.578125 MiB**.
  Порог RAM 7 GiB не нарушен; порог глобального swap-out 32 MiB нарушен.
  Это накопленный прирост с начала загрузки, не измеренная скорость swap-out.
- Новый PID/restart не зарегистрирован. Сервер после завершения процедуры
  остановки не продолжал обслуживать модель. Shutdown приложения 14:21:01 UTC
  произошёл позже; это не инициатор инцидента.

**Непосредственная причина EOF доказана:** принудительная остановка принадлежащего
launcher сервера после превышения глобального pswpout. Доказательств CUDA crash,
пользовательской отмены, HTTP timeout или самостоятельного падения backend нет.
Исторические cgroup memory.events не сохранены: категорически исключить любые
сопутствующие события OOM по этим журналам нельзя, но инициирующая остановка
launcher прямо зарегистрирована.

## Что неизвестно

Точные RSS/anon/file, process VmSwap, cgroup events/PSI и фактическая VRAM в момент
инцидента не сохранены. В loading log подтверждены MoE cache 16381.03 MiB,
GPU KV 816 MiB, GPU weights 1626.23 MiB, GPU recurrent 73.28 MiB и compute
862.50 MiB. Это allocations, **не измеренный пик VRAM при остановке**.

Нельзя определить, чьи страницы были выгружены. MemorySwapMax=0 ограничивает
модельный cgroup, но не исключает глобальный swap других процессов. Высокий
MemAvailable также не доказывает отсутствие reclaim/локального давления:
GGUF mmap file-backed страницы входят в потенциально reclaimable память.
Сохранение prompt state непосредственно перед остановкой — наблюдение, а не
доказательство причины swap-out. Утечка Rust/HTTP или ошибка expert cache
из этих данных не установлены. Остановка не объявляется ложной.

## Минимальные изменения

1. Launcher публикует offline/error с конкретным критерием **до** SIGTERM,
   затем сохраняет итоговое состояние после остановки. Ранее ошибка записывалась
   только после grace period/KILL: Rust успевал прочитать ещё ready state.
2. Rust/Electron сопоставляет memory-stop с началом run и идентичностью launcher/
   server вместо окна «последние 10 секунд»: сама остановка может длиться дольше.
   Старые ошибки до запуска задачи и ошибки другого launcher не приписываются run.
3. Через 30 секунд во время защищённой загрузки/работы и перед остановкой
   сохраняются metadata-only счётчики: PID/RSS/anon/file/swap/locked модели, Electron и до 32 его прямых дочерних процессов (включая Rust worker),
   MemAvailable и категории RAM, pswpin/out/allocstall, memory PSI,
   cgroup current/peak/max/swap/events/stat/pressure. Также сохраняется до 24
   доступных PID с наибольшим текущим VmSwap. Это не per-process swap-out rate.
   Не записываются cmdline, prompts, окружение или содержимое файлов.
4. Сохраняется waitStatus при запрошенной остановке. Пороги, cgroup,
   runtime flags и профиль не ослаблены/не изменены. Повторов tools нет.

## Проверки и границы

- Production build, TypeScript и lint: проходят.
- Shell regression: точные счётчики инцидента → global_swap_out;
  RAM criterion отдельно; ровно 32 MiB допускается, превышение останавливает;
  error уже опубликован при первом сигнале; metadata snapshot читается.
- Launcher recovery/identity/overlap/idle/failure и unexpected-exit: проходят.
  В старом lifecycle fixture добавлены отсутствовавшие переменные MTP/profile,
  необходимые существующему write_state; изменение runtime поведения не требовалось.
- Rust incremental chunks/UTF8 и EOF/cancel/reset: проходят.
- Rust Agent bridge и placement regression: проходят.
- Настоящий Electron + настоящий Rust Agent + локальный HTTP fixture:
  **20 последовательных разных read_file**, progressive reviewed final,
  затем EOF с memory-stop → правильная причина в UI, без повтора запросов
  и без изменения проверяемых файлов.
- Большая Qwen повторно не загружалась: инициатор реального обрыва уже доказан.
  Fixture не подтверждает безопасность долгого Qwen workload по RAM.
- Пользовательский профиль не переписывался; vm.swappiness остался 60.

Следующий минимальный шаг для атрибуции давления — один следующий пользовательский
запуск с обновлённым launcher: сравнить periodic/stopping cgroup anon/file/PSI и
VmSwap PID. Не менять пороги и не отключать защиту на основании одного лишь
высокого MemAvailable. При повторной остановке снимки сохраняются до удаления cgroup.
