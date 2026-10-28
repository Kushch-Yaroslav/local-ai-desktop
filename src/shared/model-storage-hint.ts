/** Mount-on-open hint applies to the desktop Linux workflow verified on Ubuntu. */
export function modelStorageHint(platform: string): string {
  return /linux/i.test(platform)
    ? 'Если модель находится на неподключённом диске, откройте этот диск в файловом менеджере, чтобы смонтировать его. Приложение обнаружит модель автоматически.'
    : 'Проверьте подключение диска с моделью и доступность файла. Приложение автоматически обновляет доступность модели.';
}
