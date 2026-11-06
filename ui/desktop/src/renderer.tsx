// Modified for Local AI Desktop: update the existing IntlProvider live on language changes.
import React, { Suspense, lazy, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { ConfigProvider } from './components/ConfigContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import SuspenseLoader from './suspense-loader';
import { applyThemeTokens } from './theme/theme-tokens';
import { currentLocale, currentMessageLocale, loadMessages, getLocale } from './i18n';

// Apply theme tokens to :root before first paint.
applyThemeTokens();

const App = lazy(() => import('./App'));

let warnedFallbackLocale = false;
function handleIntlError(err: { code: string; message?: string }) {
  if (err.code === 'MISSING_TRANSLATION' && currentLocale !== currentMessageLocale) {
    if (!warnedFallbackLocale) {
      warnedFallbackLocale = true;
      console.warn(
        `[i18n] Locale "${currentLocale}" has no translations; falling back to "${currentMessageLocale}".`
      );
    }
    return;
  }
  console.error(err);
}

function LiveIntl({
  children,
  initialMessages,
}: {
  children: React.ReactNode;
  initialMessages: Record<string, string>;
}) {
  const [locale, setLocale] = useState(currentLocale);
  const [messages, setMessages] = useState(initialMessages);
  useEffect(() => {
    const listener = () => {
      const next = getLocale();
      void loadMessages(next.messageLocale).then((catalog) => {
        setMessages(catalog);
        setLocale(next.locale);
      });
    };
    window.electron.on('app-locale-changed', listener);
    return () => window.electron.off('app-locale-changed', listener);
  }, []);
  return (
    <IntlProvider locale={locale} defaultLocale="en" messages={messages} onError={handleIntlError}>
      {children}
    </IntlProvider>
  );
}
(async () => {
  const messages = await loadMessages(currentMessageLocale);

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LiveIntl initialMessages={messages}>
        <Suspense fallback={SuspenseLoader()}>
          <ConfigProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ConfigProvider>
        </Suspense>
      </LiveIntl>
    </React.StrictMode>
  );
})();
