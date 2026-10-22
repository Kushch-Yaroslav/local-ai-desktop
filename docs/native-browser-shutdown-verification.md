# Native Browser: ошибка при закрытии приложения

Ветка: `fix/v0.3-visual-region-feedback-pan`.

## Причина и исправление

Новый скриншот показывает не JavaScript popup внутри окна, а сообщение launcher после `Electron exited status=139` (segmentation fault). В runtime log этот exit записан трижды (20:27, 21:35 и 22:51); более поздний запуск завершился в 22:52 с кодом 0, а скриншот сделан уже после него, поэтому popup оставался от предыдущего сбоя. Перед последним завершением X11 сообщил `Shm::PutImageRequest` для уже недоступного Drawable. При закрытии BrowserWindow Native Browser закрывался асинхронно из `webContents.destroyed`, но `before-quit → shutdownRuntime` не ожидал завершения зарегистрированных сессий и затем вызывал `app.exit(0)`. Это позволяло Electron завершить графический процесс, пока Chromium/Native WebContents ещё очищались. Native stack dump в окружении отсутствует, поэтому связь X11 DrawableError с SIGSEGV остаётся диагнозом гонки по lifecycle и временной последовательности, а не выводом из C++ backtrace. Скриншот сделан после более позднего запуска, который в том же log завершился с `status=0`; launcher уведомление оставалось от предыдущего exit 139.

В этой же ветке ранее исправлена отдельная гонка: при закрытии child View свойство `shield.webContents` может стать `undefined`, а `detachPan` снимал через него listener.

Теперь `before-quit` ждёт остановки Agent Runtime и `LiveBrowserHub.shutdownAll`, закрывая Browser Tool sessions, Native WebContents и CDP до `app.exit`. У каждой записи Browser Hub есть общий idempotent Promise завершения. Запись остаётся в Hub до завершения этого Promise, поэтому уничтожение окна и shutdown не теряют ссылку на ожидающую закрытия Page. Для child View сохраняется ссылка на WebContents; `detachPan` не обращается к уже уничтоженной поверхности. Ошибки очистки Page не пропускают шаг закрытия Native View.

## Проверка

`node scripts/native-browser-shutdown-electron.test.mjs` запускает настоящий Electron с отдельным временным runtime. Проверяются:

- Закрытие Native Page и повторный вызов `close` с тем же Promise.
- Уничтожение служебного WebContents перед очисткой.
- Уничтожение BrowserWindow.
- Отключение debugger/CDP.
- Уничтожение окна при активном обработчике pan.
- Полное завершение приложения с Browser Hub session: перед выходом ожидался искусственно задержанный controls.close; before-quit подтвердил его завершение и `WebContents.isDestroyed()` до `app.exit`.

На временной сборке с прежним обращением через `shield.webContents` полный выход воспроизвёл `TypeError: Cannot read properties of undefined (reading 'removeListener')` в `detachPan`. Исправленная сборка прошла все сценарии без uncaught exception и unhandled rejection; integration fixture подтвердил, что Browser Hub завершил Native Page до выхода процесса. Исключения записываются только тестовым fixture; production-обработчики не заменяются.

Renderer больше не опрашивает Visual Debugging IPC, если чат не привязан к проекту с включёнными browser tools; в launcher log такие отказы повторялись с частотой UI poll. Пользовательский runtime, история чатов, модели и проекты не изменялись. Проверка не использует LLM.
