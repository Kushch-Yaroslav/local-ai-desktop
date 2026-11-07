// Modified for Local AI Desktop: expose managed-runtime memory state in chat.
import { AppEvents } from '../constants/events';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { LiveBrowserPanel } from './liveBrowser/LiveBrowserPanel';
import { peekPendingSelection, onPendingSelectionChange } from './liveBrowser/pendingContext';
import { i18n as liveBrowserMessages } from './liveBrowser/i18n';
import { useLiveBrowserWiring } from './liveBrowser/useLiveBrowserWiring';
import { useLocation, useNavigate } from 'react-router';
import { SearchView } from './conversation/SearchView';
import LoadingGoose from './LoadingGoose';
import MessageList from './MessageList';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import ChatInput from './ChatInput';
import MemoryMonitor from './settings/localInference/MemoryMonitor';
import { ChatInputCard } from './ChatInputCard';
import { SubagentSessionNotice } from './SubagentSessionNotice';
import { Button } from './ui/button';
import { ScrollArea, ScrollAreaHandle } from './ui/scroll-area';
import { useFileDrop } from '../hooks/useFileDrop';
import { ChatState } from '../types/chatState';
import { ChatType } from '../types/chat';
import { useIsMobile } from '../hooks/use-mobile';
import { useNavigationContextSafe } from './Layout/NavigationContext';
import { cn } from '../utils';
import { useChatSession } from '../hooks/useChatSession';
import { acpUpdateWorkingDir } from '../acp/sessions';
import { useNavigation } from '../hooks/useNavigation';
import { RecipeHeader } from './RecipeHeader';
import type { Recipe } from '../recipe';
import RecipeActivities from './recipes/RecipeActivities';
import {
  getTextAndImageContent,
  type ImageData,
  type Message,
  type UserInput,
} from '../types/message';
import { useAutoSubmit } from '../hooks/useAutoSubmit';
import SessionActionsHeader from './SessionActionsHeader';
import { isAcpRecovering, subscribeToAcpRecovery } from '../acp/acpConnection';
import type { LiveVoiceAvailabilityResponse_unstable } from '@aaif/goose-acp-client';
import { acpGetLiveVoiceAvailability } from '../acp/liveVoice';
import type { LiveVoiceController } from '../liveVoice/useLiveVoice';

const NEW_LIVE_VOICE_GREETING = 'Hello! What can I help you with?';

const i18n = defineMessages({
  failedToLoadSession: {
    id: 'baseChat.failedToLoadSession',
    defaultMessage: 'Failed to Load Session',
  },
  goHome: {
    id: 'baseChat.goHome',
    defaultMessage: 'Go home',
  },
  retry: {
    id: 'baseChat.retry',
    defaultMessage: 'Retry',
  },
  reconnecting: {
    id: 'baseChat.reconnecting',
    defaultMessage: 'Connection lost. Reconnecting…',
  },
});

const isUserMessage = (message: Message) => message.role === 'user';

/**
 * Live Browser panel UI state (per chat). The browser runtime itself is
 * global and conversation-scoped on the server side; only the panel layout
 * state is remembered per conversation, so each chat keeps its own
 * Split/Expanded choice and panel width.
 */
type BrowserMode = 'chatOnly' | 'split' | 'expanded';

interface BrowserUIState {
  mode: BrowserMode;
  panelWidth: number;
}

const BROWSER_DEFAULT_PANEL_WIDTH = 520;

function browserUIStorageKey(sessionId: string): string {
  return `lad-live-browser-ui-${sessionId}`;
}

function loadBrowserUIState(sessionId: string): BrowserUIState {
  try {
    const raw = window.localStorage.getItem(browserUIStorageKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BrowserUIState>;
      const mode: BrowserMode =
        parsed.mode === 'split' || parsed.mode === 'expanded' ? parsed.mode : 'chatOnly';
      const panelWidth =
        typeof parsed.panelWidth === 'number' && Number.isFinite(parsed.panelWidth)
          ? Math.min(1200, Math.max(360, Math.round(parsed.panelWidth)))
          : BROWSER_DEFAULT_PANEL_WIDTH;
      return { mode, panelWidth };
    }
  } catch {
    // corrupted storage — fall through to defaults
  }
  return { mode: 'chatOnly', panelWidth: BROWSER_DEFAULT_PANEL_WIDTH };
}

function saveBrowserUIState(sessionId: string, state: BrowserUIState): void {
  try {
    window.localStorage.setItem(browserUIStorageKey(sessionId), JSON.stringify(state));
  } catch {
    // storage unavailable — non-fatal
  }
}

interface BaseChatProps {
  setChat: (chat: ChatType) => void;
  suppressEmptyState: boolean;
  sessionId: string;
  isActiveSession: boolean;
  initialMessage?: UserInput;
  noAutoSubmit?: boolean;
  liveVoice: LiveVoiceController;
}

export default function BaseChat({
  setChat,
  sessionId,
  initialMessage,
  noAutoSubmit,
  isActiveSession,
  liveVoice,
}: BaseChatProps) {
  const intl = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const scrollRef = useRef<ScrollAreaHandle>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const disableAnimation = location.state?.disableAnimation || false;
  const shouldStartLiveVoice = location.state?.startLiveVoice === true;
  const [hasStartedUsingRecipe, setHasStartedUsingRecipe] = React.useState(false);
  const [acpRecovering, setAcpRecovering] = useState(isAcpRecovering);
  const [liveVoiceAvailability, setLiveVoiceAvailability] =
    useState<LiveVoiceAvailabilityResponse_unstable | null>(null);
  const isMobile = useIsMobile();
  const navContext = useNavigationContextSafe();
  const setView = useNavigation();
  const {
    activeSessionId: activeLiveVoiceSessionId,
    liveVoiceSessionId,
    start: startSharedLiveVoice,
  } = liveVoice;
  const ownsLiveVoice = liveVoiceSessionId === sessionId;
  const liveVoiceActiveInAnotherSession =
    activeLiveVoiceSessionId !== null && activeLiveVoiceSessionId !== sessionId;
  const startLiveVoice = useCallback(
    async (initialCommentary?: string) => {
      if (activeLiveVoiceSessionId && activeLiveVoiceSessionId !== sessionId) {
        setView('pair', { resumeSessionId: activeLiveVoiceSessionId });
        return;
      }
      await startSharedLiveVoice(sessionId, initialCommentary);
    },
    [activeLiveVoiceSessionId, sessionId, setView, startSharedLiveVoice]
  );
  const isNavCollapsed = !navContext?.isNavExpanded;
  const contentClassName = cn('pr-1 pb-10 pt-12', (isMobile || isNavCollapsed) && 'pt-16');
  const { droppedFiles, setDroppedFiles, handleDrop, handleDragOver } = useFileDrop();
  const onStreamFinish = useCallback(() => {}, []);

  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [quoteButtonPos, setQuoteButtonPos] = useState<{ x: number; y: number } | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  // Live Browser panel: per-chat layout state (Split/Expanded/ChatOnly + width).
  const [browserMode, setBrowserMode] = useState<BrowserMode>(() =>
    loadBrowserUIState(sessionId).mode,
  );
  const [browserPanelWidth, setBrowserPanelWidth] = useState(() =>
    loadBrowserUIState(sessionId).panelWidth,
  );
  const [pendingSelection, setPendingSelectionState] = useState(() => peekPendingSelection());

  useEffect(() => {
    setBrowserMode(loadBrowserUIState(sessionId).mode);
    setBrowserPanelWidth(loadBrowserUIState(sessionId).panelWidth);
  }, [sessionId]);

  useEffect(() => {
    saveBrowserUIState(sessionId, { mode: browserMode, panelWidth: browserPanelWidth });
  }, [sessionId, browserMode, browserPanelWidth]);

  useEffect(
    () => onPendingSelectionChange(() => setPendingSelectionState(peekPendingSelection())),
    [],
  );

  // Start the Live Browser runtime once and register its MCP extension with
  // Goose so the agent has browser_* tools even when the panel is closed.
  useLiveBrowserWiring(true);

  useEffect(() => {
    const handleMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setQuoteButtonPos(null);
        return;
      }
      if (!conversationRef.current || !conversationRef.current.contains(sel.anchorNode)) {
        setQuoteButtonPos(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setQuoteButtonPos({ x: rect.left + rect.width / 2, y: rect.top - 8 });
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

  useEffect(() => subscribeToAcpRecovery(setAcpRecovering), []);

  const {
    session,
    messages,
    chatState,
    progressMessage,
    updateSession,
    handleSubmit,
    onSteerQueuedMessage,
    submitElicitationResponse,
    stopStreaming,
    retrySessionLoad,
    refreshSession,
    sessionLoadError,
    tokenState,
    notifications: toolCallNotifications,
    pauseQueueOnStop,
    queueProcessingBlocked,
    hasActiveRun,
    onMessageUpdate,
  } = useChatSession({
    sessionId,
    onStreamFinish,
  });
  const appendToChat = useCallback(
    (text: string) => handleSubmit({ msg: text, images: [] }),
    [handleSubmit]
  );

  const sessionLoaded = session !== undefined;
  const isSubagentSession = session?.session_type === 'sub_agent';
  const liveVoiceChatBusy = chatState !== ChatState.Idle;

  useEffect(() => {
    if (!isActiveSession || !shouldStartLiveVoice || liveVoiceAvailability === null) {
      return;
    }

    if (liveVoiceAvailability.status === 'ready') {
      void startLiveVoice(NEW_LIVE_VOICE_GREETING);
    }

    navigate(location, {
      replace: true,
      state: { ...location.state, startLiveVoice: undefined },
    });
  }, [
    isActiveSession,
    shouldStartLiveVoice,
    liveVoiceAvailability,
    startLiveVoice,
    location,
    navigate,
  ]);

  useEffect(() => {
    if (!isActiveSession || !sessionLoaded || acpRecovering || liveVoiceActiveInAnotherSession) {
      setLiveVoiceAvailability(null);
      return;
    }

    let current = true;
    setLiveVoiceAvailability(null);
    void acpGetLiveVoiceAvailability(sessionId).then(
      (response) => {
        if (current) {
          setLiveVoiceAvailability(response);
        }
      },
      () => {
        if (current) {
          setLiveVoiceAvailability(null);
        }
      }
    );
    return () => {
      current = false;
    };
  }, [
    acpRecovering,
    hasActiveRun,
    isActiveSession,
    liveVoice.phase,
    liveVoiceActiveInAnotherSession,
    liveVoiceChatBusy,
    session?.goose_mode,
    sessionId,
    sessionLoaded,
  ]);

  const handleWorkingDirChange = useCallback(
    async (newDir: string) => {
      if (!session) {
        throw new Error('Cannot update working directory before ACP session is loaded');
      }
      await acpUpdateWorkingDir(session.id, newDir);
      updateSession((currentSession) => ({ ...currentSession, working_dir: newDir }));
    },
    [session, updateSession]
  );

  const recipe = session?.recipe as Recipe | null | undefined;

  // noAutoSubmit only suppresses auto-submitting the initial prompt of a fresh session
  // (goose://new-session?prompt=...). Once the conversation has messages, later flows
  // such as forks or resumes should auto-submit normally.
  const suppressInitialAutoSubmit = noAutoSubmit && messages.length === 0;
  const canAutoSubmit = !acpRecovering && !suppressInitialAutoSubmit;

  useAutoSubmit({
    sessionId,
    session,
    messages,
    chatState,
    initialMessage,
    canAutoSubmit,
    handleSubmit,
  });

  useEffect(() => {
    let streamState: 'idle' | 'loading' | 'streaming' | 'error' = 'idle';
    if (chatState === ChatState.LoadingConversation) {
      streamState = 'loading';
    } else if (
      chatState === ChatState.Streaming ||
      chatState === ChatState.Thinking ||
      chatState === ChatState.Compacting
    ) {
      streamState = 'streaming';
    } else if (sessionLoadError) {
      streamState = 'error';
    }

    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_STATUS_UPDATE, {
        detail: {
          sessionId,
          streamState,
          messageCount: messages.length,
        },
      })
    );
  }, [sessionId, chatState, messages.length, sessionLoadError]);

  // Generate command history from user messages (most recent first)
  const commandHistory = useMemo(() => {
    return messages
      .reduce<string[]>((history, message) => {
        if (message.role === 'user') {
          const text = getTextAndImageContent(message).textContent.trim();
          if (text) {
            history.push(text);
          }
        }
        return history;
      }, [])
      .reverse();
  }, [messages]);

  const chatInputSubmit = (input: UserInput) => {
    if (recipe && input.msg.trim()) {
      setHasStartedUsingRecipe(true);
    }
    handleSubmit(input);
  };

  const sessionModel = session?.model_config?.model_name ?? null;
  const sessionProvider = session?.provider_name ?? null;
  const latestInference = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.role === 'assistant' &&
        message.metadata.userVisible &&
        message.metadata.inference
      ) {
        return message.metadata.inference;
      }
    }
    return null;
  }, [messages]);

  // Track if this is the initial render for session resuming
  const initialRenderRef = useRef(true);

  // Auto-scroll when messages are loaded (for session resuming)
  const handleRenderingComplete = React.useCallback(() => {
    // Only force scroll on the very first render
    if (initialRenderRef.current && messages.length > 0) {
      initialRenderRef.current = false;
      if (scrollRef.current?.scrollToBottom) {
        scrollRef.current.scrollToBottom();
      }
    } else if (scrollRef.current?.isFollowing) {
      if (scrollRef.current?.scrollToBottom) {
        scrollRef.current.scrollToBottom();
      }
    }
  }, [messages.length]);

  // Listen for global scroll-to-bottom requests (e.g., from MCP App message actions)
  useEffect(() => {
    const handleGlobalScrollRequest = () => {
      // Add a small delay to ensure content has been rendered
      setTimeout(() => {
        if (scrollRef.current?.scrollToBottom) {
          scrollRef.current.scrollToBottom();
        }
      }, 200);
    };

    window.addEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, handleGlobalScrollRequest);
    return () =>
      window.removeEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, handleGlobalScrollRequest);
  }, []);

  useEffect(() => {
    if (
      isActiveSession &&
      sessionId &&
      chatInputRef.current &&
      chatState !== ChatState.LoadingConversation
    ) {
      const timeoutId = setTimeout(() => {
        chatInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [isActiveSession, sessionId, chatState]);

  useEffect(() => {
    const handleSessionForked = (event: Event) => {
      const customEvent = event as CustomEvent<{
        newSessionId: string;
        shouldStartAgent: boolean;
        editedMessage: string;
        editedImages: ImageData[];
      }>;
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
      const { newSessionId, shouldStartAgent, editedMessage, editedImages } = customEvent.detail;

      const params = new URLSearchParams();
      params.set('resumeSessionId', newSessionId);
      if (shouldStartAgent) {
        params.set('shouldStartAgent', 'true');
      }

      navigate(`/pair?${params.toString()}`, {
        state: {
          disableAnimation: true,
          initialMessage: { msg: editedMessage, images: editedImages },
        },
      });
    };

    window.addEventListener(AppEvents.SESSION_FORKED, handleSessionForked);

    return () => {
      window.removeEventListener(AppEvents.SESSION_FORKED, handleSessionForked);
    };
  }, [location.pathname, navigate]);

  const lastSetNameRef = useRef<string>('');

  useEffect(() => {
    const currentSessionName = session?.name;
    if (currentSessionName && currentSessionName !== lastSetNameRef.current) {
      lastSetNameRef.current = currentSessionName;
      setChat({
        messages,
        recipe,
        sessionId,
        name: currentSessionName,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.name, setChat]);

  const recipePrompt = messages.length === 0 ? (recipe?.prompt ?? '') : '';

  const initialPrompt =
    noAutoSubmit && messages.length === 0 && initialMessage?.msg
      ? initialMessage.msg
      : recipePrompt;

  if (sessionLoadError) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <MainPanelLayout backgroundColor={'bg-background-primary'} removeTopPadding={true}>
          <div className="flex flex-col flex-1 min-h-0 relative">
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center justify-center p-8">
                <div className="text-red-700 dark:text-red-300 bg-red-400/50 p-4 rounded-lg mb-4 max-w-md">
                  <h3 className="font-semibold mb-2">
                    {intl.formatMessage(i18n.failedToLoadSession)}
                  </h3>
                  <p className="text-sm">{sessionLoadError}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => void retrySessionLoad()}>
                    {intl.formatMessage(i18n.retry)}
                  </Button>
                  <Button variant="outline" onClick={() => setView('chat')}>
                    {intl.formatMessage(i18n.goHome)}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </MainPanelLayout>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 relative">
      <div className="absolute right-24 top-3 z-10 max-w-[calc(100%-7rem)] pointer-events-none">
        <MemoryMonitor />
      </div>
      {!isSubagentSession && (
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
      )}
      <div className="flex min-h-0 flex-1">
        <div className={cn('flex min-w-0 flex-1 flex-col', browserMode === 'expanded' && 'hidden')}>
        <MainPanelLayout backgroundColor={'bg-background-primary'} removeTopPadding={true}>
        {/* Chat container with sticky recipe header */}
        <div className="flex flex-col flex-1 min-h-0 relative">
          <SessionActionsHeader session={session} onSessionChange={updateSession} />

          <ScrollArea
            ref={scrollRef}
            className={`flex-1 min-h-0 relative ${contentClassName}`}
            autoScroll
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            data-drop-zone="true"
            paddingX={6}
            paddingY={0}
          >
            {recipe?.title && (
              <div className="sticky top-0 z-10 bg-background-primary px-0 -mx-6 mb-6 pt-6">
                <RecipeHeader title={recipe.title} />
              </div>
            )}

            {recipe && !isSubagentSession && (
              <div className={hasStartedUsingRecipe ? 'mb-6' : ''}>
                <RecipeActivities
                  append={appendToChat}
                  activities={Array.isArray(recipe.activities) ? recipe.activities : null}
                />
              </div>
            )}

            {messages.length > 0 || recipe ? (
              <>
                <SearchView key={sessionId}>
                  <div ref={conversationRef}>
                    <MessageList
                      messages={messages}
                      sessionId={sessionId}
                      toolCallNotifications={toolCallNotifications}
                      append={isSubagentSession ? undefined : appendToChat}
                      isUserMessage={isUserMessage}
                      isStreamingMessage={chatState !== ChatState.Idle}
                      onRenderingComplete={handleRenderingComplete}
                      onMessageUpdate={isSubagentSession ? undefined : onMessageUpdate}
                      submitElicitationResponse={submitElicitationResponse}
                    />
                  </div>
                </SearchView>

                <div className="block h-8" />
              </>
            ) : null}
          </ScrollArea>

          {chatState !== ChatState.Idle && (
            <div className="absolute bottom-1 left-4 z-20 pointer-events-none">
              <LoadingGoose chatState={chatState} message={progressMessage} />
            </div>
          )}
        </div>

        {acpRecovering && (
          <div role="status" className="mx-4 mb-2 text-sm text-text-secondary">
            {intl.formatMessage(i18n.reconnecting)}
          </div>
        )}

        {quoteButtonPos && !isSubagentSession && (
          <button
            className="fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-background-inverse px-2 py-1 text-xs font-medium text-text-inverse shadow-md hover:opacity-90"
            style={{ left: quoteButtonPos.x, top: quoteButtonPos.y }}
            onMouseDown={(e) => {
              e.preventDefault();
              const sel = window.getSelection();
              const text = sel?.toString().trim() ?? '';
              if (text) {
                setPendingQuote(text);
                sel?.removeAllRanges();
              }
              setQuoteButtonPos(null);
            }}
          >
            Add to message
          </button>
        )}

        {pendingSelection && !isSubagentSession && (
          <div
            className="mx-4 mb-1 flex items-center gap-2 rounded-md border border-border-primary bg-background-secondary px-2 py-1 text-xs text-text-secondary"
            data-testid="pending-selection-note"
          >
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {intl.formatMessage(liveBrowserMessages.pendingNote, {
                names: pendingSelection.areaNames.join(', ') || 'Live Browser selection',
              })}
            </span>
          </div>
        )}

        {isSubagentSession ? (
          <SubagentSessionNotice
            refreshing={chatState === ChatState.LoadingConversation}
            onRefresh={() => void refreshSession()}
          />
        ) : (
          <ChatInputCard
            className={cn(
              'relative z-30 mx-4 mb-4',
              !disableAnimation && 'animate-[fadein_400ms_ease-in_forwards]'
            )}
          >
            <ChatInput
              inputRef={chatInputRef}
              sessionId={sessionId}
              handleSubmit={chatInputSubmit}
              chatState={chatState}
              hasActiveRun={hasActiveRun}
              onStop={stopStreaming}
              onSteerQueuedMessage={onSteerQueuedMessage}
              pauseQueueOnStop={pauseQueueOnStop}
              queueProcessingBlocked={queueProcessingBlocked || acpRecovering}
              commandHistory={commandHistory}
              initialValue={initialPrompt}
              setView={setView}
              totalTokens={tokenState?.totalTokens ?? session?.usage?.total_tokens ?? undefined}
              contextLimit={tokenState?.contextLimit}
              accumulatedInputTokens={
                tokenState?.accumulatedInputTokens ??
                session?.accumulated_usage?.input_tokens ??
                undefined
              }
              accumulatedOutputTokens={
                tokenState?.accumulatedOutputTokens ??
                session?.accumulated_usage?.output_tokens ??
                undefined
              }
              accumulatedCost={
                tokenState?.accumulatedCost ?? session?.accumulated_cost ?? undefined
              }
              droppedFiles={droppedFiles}
              onFilesProcessed={() => setDroppedFiles([])} // Clear dropped files after processing
              messages={messages}
              disableAnimation={disableAnimation}
              recipe={recipe}
              initialPrompt={initialPrompt}
              sessionModel={sessionModel}
              sessionProvider={sessionProvider}
              sessionLoaded={sessionLoaded}
              workingDir={session?.working_dir}
              onWorkingDirChange={handleWorkingDirChange}
              latestInference={latestInference}
              liveVoice={{
                availability: liveVoiceAvailability,
                phase: ownsLiveVoice ? liveVoice.phase : 'idle',
                muted: ownsLiveVoice ? liveVoice.muted : false,
                activeInAnotherSession: liveVoiceActiveInAnotherSession,
                start: () => startLiveVoice(),
                stop: liveVoice.stop,
                toggleMute: liveVoice.toggleMute,
              }}
              appendQuote={pendingQuote}
              onAppendQuoteConsumed={() => setPendingQuote(null)}
            />
          </ChatInputCard>
        )}
        </MainPanelLayout>
        </div>
        {browserMode !== 'chatOnly' && !isSubagentSession && (
          <LiveBrowserPanel
            sessionId={sessionId}
            mode={browserMode === 'expanded' ? 'expanded' : 'split'}
            onModeChange={(m) => setBrowserMode(m)}
            panelWidth={browserPanelWidth}
            onPanelWidthChange={(width) => setBrowserPanelWidth(width)}
          />
        )}
      </div>
    </div>
  );
}
