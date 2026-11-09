import { acpChatSessionActions } from '../acp/chatSessionStore';
import { browserHubId } from './liveBrowser/hubSession';
import { consumePendingSelection, setPendingSelection } from './liveBrowser/pendingContext';
import { PendingBrowserAttachments } from './liveBrowser/PendingBrowserAttachments';
// Modified for Local AI Desktop: responsive Live Browser workspace.
/**
 * Hub Component
 *
 * The empty-chat landing screen. Visually it's "Pair with no messages yet" —
 * a large time + greeting above a centered, narrower ChatInput. Submitting
 * creates a session and navigates to /pair so the rest of the chat lifecycle
 * lives there.
 * Modified for Local AI Desktop: apply per-chat controls before first submission.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLocation } from 'react-router';
import { defineMessages, useIntl } from '../i18n';
import { AppEvents } from '../constants/events';
import ChatInput from './ChatInput';
import MemoryMonitor from './settings/localInference/MemoryMonitor';
import type { NewChatSettings } from './SessionSettingsPopover';
import { configureNewChatSession } from '../acp/newChatSettings';
import { ChatInputCard } from './ChatInputCard';
import { ChatState } from '../types/chatState';
import 'react-toastify/dist/ReactToastify.css';
import { View, ViewOptions } from '../utils/navigationUtils';
import { useConfig } from './ConfigContext';
import { getEffectiveWorkingDir, getInitialWorkingDir } from '../utils/workingDir';
import { createSession } from '../sessions';
import { acpUpdateWorkingDir } from '../acp/sessions';
import LoadingGoose from './LoadingGoose';
import { UserInput } from '../types/message';
import {
  createNextChatExtensionDraft,
  selectNextChatExtensions,
  type NextChatExtensionDraft,
} from '../utils/nextChatExtensions';
import { formatAcpError } from '../acp/errors';
import { toastError } from '../toasts';
import { formatClockDisplay } from '../utils/timeUtils';
import { acpGetLiveVoiceAvailability } from '../acp/liveVoice';
import type { LiveVoiceAvailabilityResponse_unstable } from '@aaif/goose-acp-client';
import { subscribeToAcpRecovery } from '../acp/acpConnection';
import type { LiveVoiceController } from '../liveVoice/useLiveVoice';
import { Globe } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../utils';
import { LiveBrowserPanel } from './liveBrowser/LiveBrowserPanel';
import { useLiveBrowserWiring } from './liveBrowser/useLiveBrowserWiring';
import { i18n as liveBrowserMessages } from './liveBrowser/i18n';

type BrowserMode = 'chatOnly' | 'split' | 'expanded';

const i18n = defineMessages({
  goodMorning: { id: 'hub.goodMorning', defaultMessage: 'Good morning' },
  goodAfternoon: { id: 'hub.goodAfternoon', defaultMessage: 'Good afternoon' },
  goodEvening: { id: 'hub.goodEvening', defaultMessage: 'Good evening' },
});

const settingsDrafts = new WeakMap<object, NewChatSettings>();

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  return formatClockDisplay(now);
}

export default function Hub({
  setView,
  draftRef,
  liveVoice,
}: {
  setView: (view: View, viewOptions?: ViewOptions) => void;
  /** Unsent input of this screen, kept above the route outlet across the unmount. */
  draftRef: RefObject<string>;
  liveVoice: LiveVoiceController;
}) {
  const intl = useIntl();
  const hubId = useMemo(() => browserHubId(), []);
  const { state } = useLocation();
  const initialWorkingDir = (state as { workingDir?: string } | null)?.workingDir;
  const { extensionsList } = useConfig();
  const [workingDir, setWorkingDir] = useState(initialWorkingDir ?? getInitialWorkingDir());
  const userSelectedWorkingDirRef = useRef(Boolean(initialWorkingDir));
  const [projectSelected, setProjectSelected] = useState(Boolean(initialWorkingDir));
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [liveVoiceAvailability, setLiveVoiceAvailability] =
    useState<LiveVoiceAvailabilityResponse_unstable | null>(null);
  const [nextChatExtensionDraft, setNextChatExtensionDraft] =
    useState<NextChatExtensionDraft | null>(null);
  const [newChatSettings, setNewChatSettings] = useState<NewChatSettings>(
    () => settingsDrafts.get(draftRef) ?? {}
  );
  const changeNewChatSettings = (value: NewChatSettings) => {
    settingsDrafts.set(draftRef, value);
    setNewChatSettings(value);
  };

  // Live Browser in the empty-chat landing: same runtime + Goose MCP wiring as
  // BaseChat, so the agent has browser_* tools from the first screen. The
  // "hub" pseudo-conversation keeps the browser session independent of a
  // not-yet-created chat; a region marked here is queued as a pending
  // selection and prepended to the first message of the new session.
  const [browserMode, setBrowserMode] = useState<BrowserMode>('chatOnly');
  const [browserPanelWidth, setBrowserPanelWidth] = useState(520);
  useLiveBrowserWiring(true, hubId);

  // The pending selection queue is global: an area sent from the Hub panel is
  // queued here and consumed by the new session's first auto-submitted message.

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { time, meridiem, hour } = useClock();

  // Re-resolve the working dir on mount: GOOSE_WORKING_DIR is fixed at window
  // creation, so a configured remote directory may have changed since then.
  useEffect(() => {
    let active = true;
    void getEffectiveWorkingDir(initialWorkingDir).then((dir) => {
      if (active && !userSelectedWorkingDirRef.current) setWorkingDir(dir);
    });
    return () => {
      active = false;
    };
  }, [initialWorkingDir]);

  useEffect(() => {
    let requestGeneration = 0;
    const requestAvailability = async () => {
      const generation = ++requestGeneration;
      try {
        const availability = await acpGetLiveVoiceAvailability();
        if (generation === requestGeneration) {
          setLiveVoiceAvailability(availability);
        }
      } catch {
        if (generation === requestGeneration) {
          setLiveVoiceAvailability(null);
        }
      }
    };

    void requestAvailability();
    const unsubscribe = subscribeToAcpRecovery((recovering) => {
      if (!recovering) {
        void requestAvailability();
      }
    });

    return () => {
      requestGeneration += 1;
      unsubscribe();
    };
  }, []);

  const greeting = useMemo(() => {
    if (hour < 12) return intl.formatMessage(i18n.goodMorning);
    if (hour < 18) return intl.formatMessage(i18n.goodAfternoon);
    return intl.formatMessage(i18n.goodEvening);
  }, [intl, hour]);

  const draftForMenu = useMemo(
    () => nextChatExtensionDraft ?? createNextChatExtensionDraft(extensionsList),
    [extensionsList, nextChatExtensionDraft]
  );

  // rAF is more reliable than autoFocus across async render boundaries.
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  const handleNextChatExtensionDraftChange = useCallback((draft: NextChatExtensionDraft) => {
    setNextChatExtensionDraft(draft);
  }, []);

  const handleWorkingDirChange = useCallback((dir: string) => {
    userSelectedWorkingDirRef.current = true;
    setProjectSelected(true);
    setWorkingDir(dir);
  }, []);

  const preparedSession = useRef<Awaited<ReturnType<typeof createSession>> | null>(null);
  const creatingSessionRef = useRef(false);
  const createHubSession = async () => {
    if (creatingSessionRef.current) return null;
    creatingSessionRef.current = true;
    setIsCreatingSession(true);

    try {
      // A draft exists only once the user has opened the picker, so its absence is
      // "not specified" while an empty draft is "start with no extensions".
      const sessionOptions = nextChatExtensionDraft
        ? {
            extensionConfigs: selectNextChatExtensions(extensionsList, nextChatExtensionDraft),
          }
        : { allExtensions: extensionsList };

      // Resolve the effective directory at submit time: the IPC lookup may still
      // be pending when the user submits, and an explicit pick must win.
      const dir = userSelectedWorkingDirRef.current
        ? workingDir
        : await getEffectiveWorkingDir(initialWorkingDir);
      const session = preparedSession.current ?? (await createSession(dir, sessionOptions));
      if (userSelectedWorkingDirRef.current) await acpUpdateWorkingDir(session.id, dir);
      preparedSession.current = session;
      const configuredSession = await configureNewChatSession(session, newChatSettings);
      // The explicit scope was acknowledged above after session creation. Preserve
      // it in the initial UI snapshot as well as the backend extension state.
      if (userSelectedWorkingDirRef.current) {
        configuredSession.browser_project_root = dir;
        acpChatSessionActions.setSessionMetadata(configuredSession.id, configuredSession);
      }
      const browserDraft = consumePendingSelection(hubId);
      const hasBrowser = Boolean(await window.electron.liveBrowserWorkspaceRead(hubId));
      if (browserDraft || hasBrowser) {
        try {
          await window.electron.liveBrowserAdopt(hubId, configuredSession.id);
        } catch (error) {
          if (browserDraft) setPendingSelection(browserDraft);
          throw error;
        }
        if (browserDraft)
          setPendingSelection({ ...browserDraft, conversationId: configuredSession.id });
        try {
          localStorage.setItem(
            `lad-live-browser-ui-${configuredSession.id}`,
            JSON.stringify({ mode: browserMode, panelWidth: browserPanelWidth })
          );
          const preferences = localStorage.getItem(`lad.browser2:${hubId}`);
          if (preferences)
            localStorage.setItem(`lad.browser2:${configuredSession.id}`, preferences);
        } catch {
          /* Storage unavailable. */
        }
      }
      preparedSession.current = null;
      settingsDrafts.delete(draftRef);
      setNextChatExtensionDraft(null);
      return configuredSession;
    } catch (error) {
      console.error('Failed to create session:', error);
      toastError({ title: "Couldn't start chat", msg: formatAcpError(error) });
      creatingSessionRef.current = false;
      setIsCreatingSession(false);
      return null;
    }
  };

  const handleSubmit = async (input: UserInput) => {
    const { msg: userMessage, images } = input;
    if (!(images.length > 0 || userMessage.trim())) return;

    const draftAtSubmit = draftRef.current;
    const session = await createHubSession();
    if (!session) return;

    window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
    window.dispatchEvent(
      new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
        detail: { sessionId: session.id, initialMessage: { msg: userMessage, images } },
      })
    );

    // Preserve edits made while the session was being created.
    if (draftRef.current === draftAtSubmit) {
      draftRef.current = '';
    }

    setView('pair', {
      disableAnimation: true,
      resumeSessionId: session.id,
      initialMessage: { msg: userMessage, images },
    });
  };

  const handleStartLiveVoice = async () => {
    if (liveVoice.activeSessionId) {
      setView('pair', { resumeSessionId: liveVoice.activeSessionId });
      return;
    }

    const session = await createHubSession();
    if (!session) return;

    window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
    window.dispatchEvent(
      new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
        detail: { sessionId: session.id },
      })
    );

    setView('pair', {
      disableAnimation: true,
      resumeSessionId: session.id,
      startLiveVoice: true,
    });
  };

  return (
    <div className="lb-workspace flex h-full min-h-0 min-w-0 overflow-hidden relative">
      <div
        className={cn(
          'lb-chat relative flex min-h-0 min-w-0 overflow-hidden flex-1 flex-col items-center justify-center px-6',
          browserMode === 'expanded' && 'hidden'
        )}
      >
        <div className="absolute right-14 top-3 z-10 max-w-[calc(100%-3.5rem)]">
          <MemoryMonitor />
        </div>
        <div className="absolute right-3 top-3 z-[100]">
          <Button
            variant={browserMode !== 'chatOnly' ? 'secondary' : 'ghost'}
            size="sm"
            className="no-drag h-8 w-8 p-0"
            title={intl.formatMessage(liveBrowserMessages.iconTooltip)}
            aria-label={intl.formatMessage(liveBrowserMessages.iconTooltip)}
            data-testid="browser-toggle"
            data-mode={browserMode}
            onClick={() => setBrowserMode((m) => (m === 'chatOnly' ? 'split' : 'chatOnly'))}
          >
            <Globe className="h-4 w-4" />
          </Button>
        </div>
        <div className="w-full max-w-3xl">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-6xl font-light text-text-primary tracking-tight tabular-nums">
              {time}
            </span>
            {meridiem ? (
              <span className="text-2xl font-light text-text-secondary">{meridiem}</span>
            ) : null}
          </div>
          <p className="text-xl text-text-secondary mb-6">{greeting}</p>

          <PendingBrowserAttachments conversationId={hubId} />

          <ChatInputCard>
            <ChatInput
              sessionId={null}
              newChatSettings={newChatSettings}
              onNewChatSettingsChange={changeNewChatSettings}
              draftRef={draftRef}
              handleSubmit={handleSubmit}
              chatState={isCreatingSession ? ChatState.LoadingConversation : ChatState.Idle}
              hasActiveRun={false}
              onStop={() => {}}
              initialValue=""
              setView={setView}
              totalTokens={0}
              accumulatedInputTokens={0}
              accumulatedOutputTokens={0}
              droppedFiles={[]}
              onFilesProcessed={() => {}}
              messages={[]}
              disableAnimation={false}
              workingDir={workingDir}
              onWorkingDirChange={handleWorkingDirChange}
              inputRef={inputRef}
              nextChatExtensionDraft={draftForMenu}
              onNextChatExtensionDraftChange={handleNextChatExtensionDraftChange}
              liveVoice={{
                availability: isCreatingSession ? null : liveVoiceAvailability,
                phase: 'idle',
                muted: false,
                activeInAnotherSession: liveVoice.activeSessionId !== null,
                start: handleStartLiveVoice,
                stop: liveVoice.stop,
                toggleMute: liveVoice.toggleMute,
              }}
            />
          </ChatInputCard>
        </div>

        {isCreatingSession && (
          <div className="absolute bottom-4 left-4 z-20 pointer-events-none">
            <LoadingGoose chatState={ChatState.LoadingConversation} />
          </div>
        )}
      </div>
      {browserMode !== 'chatOnly' && (
        <LiveBrowserPanel
          sessionId={hubId}
          projectId={projectSelected ? workingDir : undefined}
          mode={browserMode === 'expanded' ? 'expanded' : 'split'}
          onModeChange={(m) => setBrowserMode(m)}
          panelWidth={browserPanelWidth}
          onPanelWidthChange={(width) => setBrowserPanelWidth(width)}
        />
      )}
    </div>
  );
}
