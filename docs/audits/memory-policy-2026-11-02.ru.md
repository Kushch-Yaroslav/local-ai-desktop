# Политика памяти: global swap-out только для диагностики

По решению владельца проекта отменён hard-stop по накопленному глобальному
`pswpout`. Ни 32, ни 64, ни 256 MiB сами по себе не вызывают SIGTERM/SIGKILL.
Отсутствие счётчика swap-out также не останавливает модель.

Сохраняются резерв MemAvailable 7 GiB, остановка при отсутствии необходимой
RAM-телеметрии, MemorySwapMax=0, существующий MemoryMax, VRAM preflight,
единственный owned llama-server, проверки процесса и диагностика PSI/cgroup.
MemoryMax не менялся: фактически резидентные mmap/file-cache страницы учитываются
cgroup; размер виртуального отображения GGUF сам по себе не равен потреблению
этого лимита. Оснований отключать лимит в этой задаче нет.

При недостаточном резерве RAM launcher публикует точный критерий до первого
сигнала и останавливает только принадлежащую ему модель. Swap-out остаётся
в periodic/stopping metadata snapshots и может присутствовать в сообщении
об остановке как диагностическое значение, но не как её причина.

При неожиданном exit сохраняются status и доступные cgroup memory.events.
Путь owned cgroup запоминается до исчезновения /proc/PID. Если systemd уже
удалил scope, events явно unavailable; OOM не выводится из одного лишь SIGKILL.
Agent UI использует коррелированную причину launcher, включая unexpected exit,
а выполненные инструменты автоматически не повторяет.

Проверки: mock swap 32/64/256 MiB и счётчики прошлого инцидента проходят без
остановки; падение RAM ниже 7 GiB сохраняет остановку; ровно 7 GiB допускается;
отсутствие swap-счётчика допускается, отсутствие RAM-телеметрии блокируется.
Mock cgroup OOM/exit 137 и обычный exit 17 публикуют offline с диагностикой.
Обычная остановка fixture-owned процесса проходит. Shell launcher suite,
TypeScript, lint, production build и Agent bridge проходят.
Настоящий Electron/Rust Agent с HTTP fixture проверяет EOF после mock RAM-stop:
правильная причина в UI, без повторов tools и изменения fixture-файлов.

Rust source, streaming, MoE, placement и профили не менялись. Целостность файла
профилей проверена SHA-256 до/после тестов. Qwen 16 GiB/48 layers/CPU MoE all/
64K Q8 GPU KV/mmap/MTP off сохранена; повторно модель не загружалась.
Системный swap и vm.swappiness не менялись.
