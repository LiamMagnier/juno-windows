/**
 * Chat surface container: routes threadStore.activeConversationId (null =
 * new chat) to a scrollable transcript + pinned composer, the new-chat
 * greeting state, and the artifacts side panel.
 */
import { useCallback, useEffect, useMemo } from "react";
import { LockKeyhole, PanelLeft } from "lucide-react";
import { useDataStore } from "@/state/dataStore";
import { useThreadStore } from "@/state/threadStore";
import { useAuthStore } from "@/state/authStore";
import { sendMessage } from "@/lib/chat/chatEngine";
import { DotMatrixMark } from "@/components/signature/DotMatrix";
import { useUiStore } from "@/state/uiStore";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { EFFORT_NONE, useChatPrefs } from "./chatPrefs";
import { defaultEffort, greetingForHour, resolveModelId } from "./helpers";
import "./chat.css";

export function ChatView() {
  const activeId = useThreadStore((s) => s.activeConversationId);
  const privateMode = useThreadStore((s) => s.privateMode);
  const conversationId = activeId && activeId !== "new" && !privateMode ? activeId : null;
  const threadKey = privateMode ? "private" : (conversationId ?? "new");
  const thread = useThreadStore((s) => s.threads[threadKey]);
  const openThread = useThreadStore((s) => s.openThread);

  const conversation = useDataStore((s) =>
    conversationId ? s.conversations[conversationId] : undefined,
  );
  const manifest = useDataStore((s) => s.manifest);
  const settings = useDataStore((s) => s.settings);
  const quota = useDataStore((s) => s.quota);
  const subscription = useDataStore((s) => s.subscription);
  const profile = useAuthStore((s) => s.profile);

  const modelOverride = useChatPrefs((s) => s.modelByThread[threadKey]);
  const lastModel = useChatPrefs((s) => s.lastModel);

  const models = useMemo(() => manifest?.models ?? [], [manifest]);
  const plan = quota?.plan ?? subscription?.plan ?? "free";

  const modelId = useMemo(
    () =>
      resolveModelId(models, plan, [
        modelOverride,
        conversation?.model,
        conversationId === null ? lastModel : null,
        settings?.defaultModel,
      ]),
    [models, plan, modelOverride, conversation?.model, conversationId, lastModel, settings?.defaultModel],
  );

  useEffect(() => {
    if (conversationId) void openThread(conversationId);
  }, [conversationId, openThread]);

  const handleRegenerate = useCallback(() => {
    if (!conversationId || !modelId) return;
    const prefs = useChatPrefs.getState();
    const model = models.find((m) => m.id === modelId);
    const stored = prefs.effortByModel[modelId];
    const effort =
      stored === EFFORT_NONE ? null : (stored ?? (model ? defaultEffort(model) : null));
    const connectors =
      prefs.connectorsByThread[threadKey] ?? conversation?.activeConnectors ?? [];
    void sendMessage({
      conversationId,
      message: "",
      model: modelId,
      regenerate: true,
      ...(model?.capabilities.webSearch ? { webSearch: prefs.webSearch } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      connectors: connectors.slice(0, 5),
      canvasEnabled: prefs.canvas,
      ...(prefs.deepResearchByThread[threadKey] ? { deepResearch: true } : {}),
    });
  }, [conversationId, modelId, models, threadKey, conversation?.activeConnectors]);

  // Continue pill for length / network_error finishes: a plain follow-up
  // send with the same options as a regenerate.
  const handleContinue = useCallback(() => {
    if (!conversationId || !modelId) return;
    const prefs = useChatPrefs.getState();
    const model = models.find((m) => m.id === modelId);
    const stored = prefs.effortByModel[modelId];
    const effort =
      stored === EFFORT_NONE ? null : (stored ?? (model ? defaultEffort(model) : null));
    const connectors =
      prefs.connectorsByThread[threadKey] ?? conversation?.activeConnectors ?? [];
    void sendMessage({
      conversationId,
      message: "Continue from where you left off.",
      model: modelId,
      ...(model?.capabilities.webSearch ? { webSearch: prefs.webSearch } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      connectors: connectors.slice(0, 5),
      canvasEnabled: prefs.canvas,
      ...(prefs.deepResearchByThread[threadKey] ? { deepResearch: true } : {}),
    });
  }, [conversationId, modelId, models, threadKey, conversation?.activeConnectors]);

  const messages = thread?.messages ?? [];
  const artifacts = thread?.artifacts ?? [];
  const status = thread?.status ?? "idle";
  const loading = thread?.loading ?? false;
  const loadError = thread?.loadError ?? null;

  const greeting = useMemo(() => {
    if (privateMode) return "You're in private";
    const base = greetingForHour(new Date().getHours());
    const first = profile?.name?.trim().split(/\s+/)[0];
    return first ? `${base}, ${first}` : base;
  }, [privateMode, profile?.name]);

  const composer = (
    <Composer
      key={threadKey}
      threadKey={threadKey}
      conversationId={conversationId}
      privateMode={privateMode}
      status={status}
      modelId={modelId}
      models={models}
      plan={plan}
    />
  );

  const header = (
    <header className="chat-topbar">
      <button
        type="button"
        className="chat-topbar-icon"
        aria-label="Toggle sidebar"
        title="Toggle sidebar (Ctrl+B)"
        onClick={() => useUiStore.getState().toggleSidebar()}
      >
        <PanelLeft size={17} aria-hidden />
      </button>
      <div className="chat-topbar-copy">
        <span className="chat-topbar-title">
          {privateMode ? "Private chat" : (conversation?.title ?? "New chat")}
        </span>
        {privateMode ? (
          <span className="chat-topbar-status"><LockKeyhole size={11} aria-hidden /> On-device only</span>
        ) : null}
      </div>
    </header>
  );

  // Loading / error for an existing conversation with nothing local yet.
  if (conversationId && messages.length === 0 && (loading || loadError)) {
    return (
      <div className="chat-root">
        <div className="chat-main">
          {header}
          <div className="chat-empty">
            {loading ? (
              <p className="chat-muted" role="status">
                Loading conversation…
              </p>
            ) : (
              <div className="chat-load-error" role="alert">
                <p>{loadError}</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void openThread(conversationId)}
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const showEmptyState = messages.length === 0;

  return (
    <div className="chat-root">
      <div className="chat-main">
        {header}
        {showEmptyState ? (
          <div className="chat-empty">
            <div className="chat-empty-mark" aria-hidden>
              <DotMatrixMark size={30} />
            </div>
            <h1 className="chat-greeting">{greeting}</h1>
            <p className="chat-empty-subtitle">
              {privateMode
                ? "This conversation stays on this device and won’t appear in history."
                : "Ask a question, explore an idea, or bring in a file to get started."}
            </p>
            <div className="chat-empty-composer">{composer}</div>
          </div>
        ) : (
          <>
            <MessageList
              threadKey={threadKey}
              conversationId={conversationId}
              privateMode={privateMode}
              status={status}
              messages={messages}
              modelId={modelId}
              onRegenerate={handleRegenerate}
              onContinue={handleContinue}
            />
            <div className="chat-composer-wrap">{composer}</div>
          </>
        )}
      </div>
      {artifacts.length > 0 ? <ArtifactsPanel artifacts={artifacts} /> : null}
    </div>
  );
}
