// Local AI Desktop: persisted application storage selection, explicit apply, native directory dialog.
import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../../i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../ui/dialog';
import type { StoragePreview, StorageProgress, StorageStatus } from '../../../storageTypes';
export const storageMessages = defineMessages({
  title: { id: 'storage.title', defaultMessage: 'Application Storage' },
  description: {
    id: 'storage.description',
    defaultMessage:
      'Choose where chat history, model profiles, cache and logs are stored. GGUF model files keep their existing locations.',
  },
  default: { id: 'storage.default', defaultMessage: 'Use the default location' },
  defaultPath: { id: 'storage.defaultPath', defaultMessage: 'System default location' },
  custom: { id: 'storage.custom', defaultMessage: 'Custom location' },
  browse: { id: 'storage.browse', defaultMessage: 'Choose folder' },
  apply: { id: 'storage.apply', defaultMessage: 'Apply location' },
  effective: { id: 'storage.effective', defaultMessage: 'Current data location' },
  cache: { id: 'storage.cache', defaultMessage: 'Cache' },
  logs: { id: 'storage.logs', defaultMessage: 'Logs' },
  config: { id: 'storage.config', defaultMessage: 'Configuration' },
  artifacts: { id: 'storage.artifacts', defaultMessage: 'Artifacts and backups' },
  free: { id: 'storage.free', defaultMessage: 'Available space: {space}' },
  split: {
    id: 'storage.split',
    defaultMessage:
      'This filesystem is used for cache, logs and artifacts. Chat history and sensitive state remain on a compatible filesystem, shown above.',
  },
  confirm: { id: 'storage.confirm', defaultMessage: 'Move storage and restart?' },
  confirmText: {
    id: 'storage.confirmText',
    defaultMessage:
      'Open chats and model work will stop. The app will copy and verify your data, then restart. Original data is retained until the new storage is verified.',
  },
  required: {
    id: 'storage.required',
    defaultMessage: 'Space required for a verified copy: {space}',
  },
  restart: { id: 'storage.restart', defaultMessage: 'Move and restart' },
  cancel: { id: 'storage.cancel', defaultMessage: 'Cancel' },
  checking: { id: 'storage.checking', defaultMessage: 'Checking storage…' },
  copying: { id: 'storage.copying', defaultMessage: 'Copying and verifying files…' },
  verifying: { id: 'storage.verifying', defaultMessage: 'Checking database integrity…' },
  restarting: { id: 'storage.restarting', defaultMessage: 'Restarting with the new storage…' },
  error: { id: 'storage.error', defaultMessage: 'Storage could not be changed: {reason}' },
  retry: { id: 'storage.retry', defaultMessage: 'Retry' },
  retained: {
    id: 'storage.retained',
    defaultMessage:
      'Previous data is retained for rollback. Historical migration sources and backups are preserved.',
  },
  cleanup: { id: 'storage.cleanup', defaultMessage: 'Free verified previous transfer copies' },
  rollback: { id: 'storage.rollback', defaultMessage: 'Return to previous storage' },
  recovered: {
    id: 'storage.recovered',
    defaultMessage: 'An interrupted transfer kept its original data. You can retry the operation.',
  },
  unchanged: { id: 'storage.unchanged', defaultMessage: 'This location is already applied.' },
  insufficientSpace: {
    id: 'storage.insufficientSpace',
    defaultMessage: 'There is not enough free space for a verified copy.',
  },
  destinationConflict: {
    id: 'storage.destinationConflict',
    defaultMessage:
      'The destination contains existing or incompatible data. Choose another folder.',
  },
  unavailable: {
    id: 'storage.unavailable',
    defaultMessage: 'The selected disk is unavailable. Mount it and try again.',
  },
  unsafeDefault: {
    id: 'storage.unsafeDefault',
    defaultMessage: 'A compatible filesystem is required for permanent application data.',
  },
  storageInUse: {
    id: 'storage.storageInUse',
    defaultMessage: 'Another process is using the storage. Close that app and retry.',
  },
  databaseBusyOrInvalid: {
    id: 'storage.databaseBusyOrInvalid',
    defaultMessage:
      'A database is busy or failed its integrity check. The original data is retained.',
  },
  migrationBusy: {
    id: 'storage.migrationBusy',
    defaultMessage: 'A storage transfer is already running.',
  },
  permission: {
    id: 'storage.permission',
    defaultMessage:
      'The app cannot write to this folder. Choose another folder or check its permissions.',
  },
  invalidPath: {
    id: 'storage.invalidPath',
    defaultMessage: 'Choose an application storage folder.',
  },
  nestedStorage: {
    id: 'storage.nestedStorage',
    defaultMessage: 'Choose a folder outside the current application storage.',
  },
  unsupportedPlatform: {
    id: 'storage.unsupportedPlatform',
    defaultMessage: 'Storage migration is currently available on Linux.',
  },
  sourceChanged: {
    id: 'storage.sourceChanged',
    defaultMessage:
      'Source data changed during verification. It has been retained; close other app instances and retry.',
  },
  recoveryRequired: {
    id: 'storage.recoveryRequired',
    defaultMessage: 'Restart the app to recover an interrupted transfer before retrying.',
  },
  weightsInsideStorage: {
    id: 'storage.weightsInsideStorage',
    defaultMessage:
      'GGUF weights were found inside application storage. Keep models in a separate folder before moving storage.',
  },
  unidentifiedVolume: {
    id: 'storage.unidentifiedVolume',
    defaultMessage: 'The selected volume cannot be identified safely. Choose a local mounted disk.',
  },
  chooseAppFolder: {
    id: 'storage.chooseAppFolder',
    defaultMessage: 'Choose a dedicated folder for application storage.',
  },
});
const bytes = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GiB`;
export default function ApplicationStorage() {
  const intl = useIntl();
  const t = (key: keyof typeof storageMessages) => intl.formatMessage(storageMessages[key]);
  const [status, setStatus] = useState<StorageStatus>();
  const [useDefault, setUseDefault] = useState(true);
  const [customPath, setCustomPath] = useState('');
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<StoragePreview>();
  const [progress, setProgress] = useState<StorageProgress>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    const s = await window.electron.storageStatus();
    setStatus(s);
    setUseDefault(s.useDefault);
    setCustomPath(s.customPath);
  };
  const explain = (e: unknown) => {
    const raw = String(e);
    const key = [
      'insufficientSpace',
      'destinationConflict',
      'unavailable',
      'unsafeDefault',
      'storageInUse',
      'databaseBusyOrInvalid',
      'migrationBusy',
      'invalidPath',
      'nestedStorage',
      'unsupportedPlatform',
      'sourceChanged',
      'recoveryRequired',
      'weightsInsideStorage',
      'unidentifiedVolume',
      'chooseAppFolder',
    ].find((k) => raw.includes(k)) as keyof typeof storageMessages | undefined;
    return key ? t(key) : /EACCES|EPERM/.test(raw) ? t('permission') : raw;
  };
  useEffect(() => {
    let alive = true;
    void window.electron
      .storageStatus()
      .then((s) => {
        if (alive) {
          setStatus(s);
          setUseDefault(s.useDefault);
          setCustomPath(s.customPath);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    const off = window.electron.storageProgress((p) => {
      setProgress(p);
      if (p.error) setError(p.error);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  const check = async () => {
    setPending(true);
    setError('');
    setNotice('');
    try {
      const p = await window.electron.storagePreview({ useDefault, customPath });
      if (p.unchanged) setNotice(t('unchanged'));
      else setPreview(p);
    } catch (e) {
      setError(explain(e));
    } finally {
      setPending(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setPending(true);
    setError('');
    try {
      await window.electron.storageApply(preview.choice);
      setPreview(undefined);
      setProgress({ phase: 'checking', completed: 0, total: 0 });
    } catch (e) {
      setError(explain(e));
      setPending(false);
    }
  };
  const busy = pending || status?.busy === true;
  return (
    <Card id="application-storage" className="rounded-lg">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={useDefault}
            disabled={!status || busy}
            onChange={(e) => {
              setUseDefault(e.target.checked);
              setError('');
              setNotice('');
            }}
          />
          {t('default')}
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t('defaultPath')}</span>
          <Input readOnly value={status?.defaultPath ?? ''} />
        </label>
        <div className="block space-y-1 text-sm">
          <label htmlFor="storage-custom-path">{t('custom')}</label>
          <div className="flex gap-2">
            <Input
              id="storage-custom-path"
              readOnly
              disabled={useDefault || busy}
              value={customPath}
            />
            <Button
              variant="outline"
              disabled={useDefault || busy || !status}
              onClick={async () => {
                try {
                  const folder = await window.electron.storageChoose();
                  if (folder) {
                    setCustomPath(folder);
                    setError('');
                    setNotice('');
                  }
                } catch (e) {
                  setError(explain(e));
                }
              }}
            >
              {t('browse')}
            </Button>
          </div>
        </div>
        {status && (
          <div className="rounded-lg border border-border-primary p-3 text-sm space-y-2 break-all">
            <p>
              <strong>{t('effective')}</strong>
              <br />
              {status.layout.dataRoot}
            </p>
            <p>
              {t('config')}: {status.layout.configRoot}
            </p>
            <p>
              {t('cache')}: {status.layout.cacheRoot}
            </p>
            <p>
              {t('logs')}: {status.layout.logsRoot}
            </p>
            <p>
              {t('artifacts')}: {status.layout.artifactsRoot}
              <br />
              {status.layout.backupsRoot}
            </p>
            {status.freeBytes !== undefined && (
              <p>
                {intl.formatMessage(storageMessages.free, { space: bytes(status.freeBytes) })}
                {status.filesystem ? ` · ${status.filesystem}` : ''}
              </p>
            )}
            {status.split && <p className="text-text-secondary">{t('split')}</p>}
          </div>
        )}
        {status?.recoveryAvailable && <p role="status">{t('recovered')}</p>}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="text-text-danger">
            {intl.formatMessage(storageMessages.error, { reason: error })}
          </p>
        )}
        {progress && (
          <div role="status">
            <p>
              {t(
                progress.phase in storageMessages
                  ? (progress.phase as keyof typeof storageMessages)
                  : 'checking'
              )}
            </p>
            {progress.total > 0 && (
              <progress className="w-full" value={progress.completed} max={progress.total} />
            )}
          </div>
        )}
        <Button
          disabled={!status || busy || (!useDefault && !customPath)}
          onClick={() => void check()}
        >
          {error ? t('retry') : t('apply')}
        </Button>
        {status?.cleanupAvailable && (
          <div className="space-y-2 border-t border-border-primary pt-3">
            <p className="text-sm text-text-secondary">{t('retained')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  try {
                    await window.electron.storageCleanup();
                    await refresh();
                  } catch (e) {
                    setError(explain(e));
                  }
                }}
              >
                {t('cleanup')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setPending(true);
                  try {
                    await window.electron.storageRollback();
                  } catch (e) {
                    setPending(false);
                    setError(explain(e));
                  }
                }}
              >
                {t('rollback')}
              </Button>
            </div>
          </div>
        )}
        <Dialog
          open={!!preview}
          onOpenChange={(open) => {
            if (!open && !pending) setPreview(undefined);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('confirm')}</DialogTitle>
            </DialogHeader>
            <p>{t('confirmText')}</p>
            <p className="break-all text-sm">{preview?.layout.dataRoot}</p>
            {preview?.split && <p>{t('split')}</p>}
            <p>
              {intl.formatMessage(storageMessages.required, {
                space: bytes(preview?.requiredBytes ?? 0),
              })}
            </p>
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={() => setPreview(undefined)}>
                {t('cancel')}
              </Button>
              <Button disabled={pending} onClick={() => void apply()}>
                {t('restart')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
