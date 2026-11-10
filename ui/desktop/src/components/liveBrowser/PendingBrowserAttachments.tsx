import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { browserPageLabel } from './attachments';
import { i18n } from './i18n';
import { X, Layers } from 'lucide-react';
import {
  peekPendingSelection,
  onPendingSelectionChange,
  setPendingSelection,
} from './pendingContext';
export function PendingBrowserAttachments({ conversationId }: { conversationId: string }) {
  const intl = useIntl();
  const [draft, setDraft] = useState(() => peekPendingSelection(conversationId));
  useEffect(() => {
    setDraft(peekPendingSelection(conversationId));
    return onPendingSelectionChange(() => setDraft(peekPendingSelection(conversationId)));
  }, [conversationId]);
  if (!draft?.attachments?.length) return null;
  return (
    <div className="mx-4 mb-2 flex flex-wrap gap-2" data-testid="pending-selection-note">
      {draft.attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex items-start gap-1 rounded-xl border border-border-primary bg-background-secondary px-3 py-2 text-xs"
        >
          <details>
            <summary className="flex cursor-pointer items-center gap-2">
              <Layers size={13} />
              {attachment.name} · {browserPageLabel(attachment.url)}
              <span className="text-text-secondary">
                {intl.formatMessage(i18n.attachmentRegionsCount, { count: attachment.regionCount })}
              </span>
              {attachment.description && (
                <span className="rounded bg-background-primary px-1.5 py-0.5 text-text-secondary">
                  {intl.formatMessage(i18n.attachmentHasDescription)}
                </span>
              )}
            </summary>
            <div className="mt-2 max-w-sm break-all text-text-secondary">
              {attachment.url}
              <p>
                {intl.formatMessage(i18n.visionLabel)}{' '}
                {intl.formatMessage(attachment.vision ? i18n.visionOn : i18n.visionOff)}
              </p>
              {attachment.description && <p>{attachment.description}</p>}
              <p>
                {attachment.projectRoot ??
                  (attachment.projectBound
                    ? intl.formatMessage(i18n.projectLinked)
                    : intl.formatMessage(i18n.noProjectBound))}
              </p>
            </div>
          </details>
          <button
            aria-label={intl.formatMessage(i18n.removeAttachment, { name: attachment.name })}
            onClick={() => {
              const attachments = draft.attachments!.filter((a) => a.id !== attachment.id);
              setPendingSelection(
                attachments.length
                  ? { ...draft, attachments, areaNames: attachments.map((a) => a.name) }
                  : null,
                conversationId
              );
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
