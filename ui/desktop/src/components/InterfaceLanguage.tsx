// Local AI Desktop: accessible onboarding selector using Goose's persisted language setting.
import { useState } from 'react';
import { useIntl } from '../i18n';
import { ggufMessages } from '../ggufMessages';
export default function InterfaceLanguage() {
  const intl = useIntl();
  const [value, setValue] = useState(intl.locale.startsWith('ru') ? 'ru' : 'en');
  return (
    <label className="flex items-center gap-3 text-sm text-text-primary">
      <span>{intl.formatMessage(ggufMessages.language)}</span>
      <select
        aria-label={intl.formatMessage(ggufMessages.language)}
        className="rounded-lg border border-border-primary bg-background-primary p-2"
        value={value}
        onChange={async (event) => {
          const next = event.target.value as 'en' | 'ru';
          await window.electron.setSetting('language', next);
          setValue(next);
        }}
      >
        <option value="en">English</option>
        <option value="ru">Русский</option>
      </select>
    </label>
  );
}
