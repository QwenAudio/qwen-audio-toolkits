import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  CircleStop,
  Cpu,
  LoaderCircle,
  NotebookPen,
  Send,
  ShieldQuestion,
  Terminal,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import { t, useLocale } from "../i18n";
import {
  cancelAcpTurn,
  finishAcpSession,
  listAcpProviders,
  respondAcpPermission,
  sendAcpPrompt,
  startAcpSession,
  subscribeAcpSession,
} from "../services/acp";
import type {
  AcpProviderInfo,
  AcpSessionEvent,
  AudioClip,
  AsrTranscriptionResult,
  AudioProcessResult,
  HarnessExecution,
  ModelPlugin,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
} from "../types";
import "./AgentChatView.css";

const MeetingNotesView = lazy(() =>
  import("./MeetingNotesView").then((module) => ({
    default: module.MeetingNotesView,
  })),
);

const PROVIDER_STORAGE_KEY = "qwen-audio-toolkits.acp-provider-v1";
const MEETING_TOOL_PATTERN = /meeting[\s_-]*(capture|transcript|notes)/iu;

type TimelineItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      title: string;
      status: string;
      content?: string;
    }
  | {
      kind: "plan";
      id: string;
      entries: Array<{ content?: string; status?: string }>;
    }
  | {
      kind: "permission";
      id: string;
      title?: string;
      options: Array<{ optionId: string; name: string; kind: string }>;
      resolved: boolean;
    };

interface AgentChatViewProps {
  initialInstruction: string;
  initialSourcePath: string;
  initialLaunchId: number;
  models: ModelPlugin[];
  onRunText: (
    text: string,
    capability: "text.generate",
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    dependencyRunIds?: string[],
    conversationVisible?: boolean,
  ) => Promise<
    HarnessExecution<
      TtsGenerateResult | TextGenerateResult | Record<string, unknown>
    >
  >;
  onRunAudio: (
    clip: AudioClip,
    capability: "speaker.diarize",
    providerId: string,
    modelId: string,
    parameters: Record<string, unknown>,
    conversationVisible?: boolean,
    dependencyRunIds?: string[],
  ) => Promise<
    HarnessExecution<
      | AsrTranscriptionResult
      | VadDetectionResult
      | AudioProcessResult
      | Record<string, unknown>
    >
  >;
  onOpenStore: () => void;
  onAction: (message: string) => void;
}

function readPreferredProvider(): string | null {
  try {
    return globalThis.localStorage?.getItem(PROVIDER_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writePreferredProvider(providerId: string) {
  try {
    globalThis.localStorage?.setItem(PROVIDER_STORAGE_KEY, providerId);
  } catch {
    // Provider preference is best-effort only.
  }
}

export function AgentChatView({
  initialInstruction,
  initialSourcePath,
  initialLaunchId,
  models,
  onRunText,
  onRunAudio,
  onOpenStore,
  onAction,
}: AgentChatViewProps) {
  useLocale();
  const [providers, setProviders] = useState<AcpProviderInfo[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStarting, setSessionStarting] = useState(false);
  const [turnActive, setTurnActive] = useState(false);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<"meeting-notes" | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const launchedRef = useRef(0);

  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.available),
    [providers],
  );
  const activeProvider = useMemo(
    () =>
      availableProviders.find((provider) => provider.id === providerId) ?? null,
    [availableProviders, providerId],
  );

  useEffect(() => {
    let disposed = false;
    void listAcpProviders()
      .then((next) => {
        if (disposed) return;
        setProviders(next);
        const preferred = readPreferredProvider();
        setProviderId((current) => {
          if (current) return current;
          const usable = next.find(
            (provider) => provider.id === preferred && provider.available,
          );
          return (
            usable?.id ??
            next.find((provider) => provider.available)?.id ??
            null
          );
        });
      })
      .catch((error) => {
        if (!disposed) {
          setNotice(t("无法读取 Agent 列表：{0}", [String(error)]));
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  const appendItem = useCallback((item: TimelineItem) => {
    setItems((current) => [...current, item]);
  }, []);

  const startSession = useCallback(
    async (provider: string, firstPrompt?: string) => {
      setSessionStarting(true);
      setNotice(null);
      try {
        const started = await startAcpSession({ providerId: provider });
        if (
          sessionIdRef.current &&
          sessionIdRef.current !== started.sessionId
        ) {
          await finishAcpSession(sessionIdRef.current).catch(() => undefined);
        }
        sessionIdRef.current = started.sessionId;
        setSessionId(started.sessionId);
        setItems([]);
        writePreferredProvider(provider);
        if (firstPrompt && firstPrompt.trim()) {
          appendItem({
            kind: "user",
            id: crypto.randomUUID(),
            text: firstPrompt.trim(),
          });
          setTurnActive(true);
          await sendAcpPrompt(started.sessionId, firstPrompt);
        }
      } catch (error) {
        setNotice(t("无法启动 {0}：{1}", [provider, String(error)]));
      } finally {
        setSessionStarting(false);
      }
    },
    [appendItem],
  );

  useEffect(() => {
    if (
      launchedRef.current >= initialLaunchId ||
      !initialInstruction.trim() ||
      !providerId
    ) {
      return;
    }
    launchedRef.current = initialLaunchId;
    const firstPrompt = initialSourcePath
      ? `${initialInstruction}\n\n${t("附件文件：{0}", [initialSourcePath])}`
      : initialInstruction;
    void startSession(providerId, firstPrompt);
  }, [
    initialInstruction,
    initialSourcePath,
    initialLaunchId,
    providerId,
    startSession,
  ]);

  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;
    void subscribeAcpSession((event: AcpSessionEvent) => {
      if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current)
        return;
      setItems((current) => {
        switch (event.kind) {
          case "agent_message_chunk": {
            const text = event.text ?? "";
            if (!text) return current;
            const last = current.at(-1);
            if (
              last?.kind === "assistant" &&
              (event.messageId ? last.id === event.messageId : true)
            ) {
              return [
                ...current.slice(0, -1),
                { ...last, text: last.text + text },
              ];
            }
            return [
              ...current,
              {
                kind: "assistant",
                id: event.messageId ?? crypto.randomUUID(),
                text,
              },
            ];
          }
          case "agent_thought_chunk": {
            const text = event.text ?? "";
            if (!text) return current;
            const last = current.at(-1);
            if (last?.kind === "thought") {
              return [
                ...current.slice(0, -1),
                { ...last, text: last.text + text },
              ];
            }
            return [
              ...current,
              { kind: "thought", id: crypto.randomUUID(), text },
            ];
          }
          case "tool_call":
          case "tool_call_update": {
            const callId = event.toolCallId ?? crypto.randomUUID();
            const next = {
              kind: "tool" as const,
              id: callId,
              title: event.toolTitle ?? t("工具调用"),
              status: event.status ?? "pending",
              content: event.content,
            };
            const index = current.findIndex(
              (item) =>
                (item.kind === "tool" || item.kind === "permission") &&
                item.id === callId,
            );
            if (index === -1) return [...current, next];
            const existing = current[index];
            if (existing.kind !== "tool") return [...current, next];
            return [
              ...current.slice(0, index),
              { ...existing, ...next, title: next.title || existing.title },
              ...current.slice(index + 1),
            ];
          }
          case "plan": {
            return [
              ...current,
              {
                kind: "plan",
                id: crypto.randomUUID(),
                entries: event.plan ?? [],
              },
            ];
          }
          case "permission_requested": {
            return [
              ...current,
              {
                kind: "permission",
                id: event.requestId ?? crypto.randomUUID(),
                title: event.title,
                options: event.options ?? [],
                resolved: false,
              },
            ];
          }
          case "permission_resolved": {
            return current.map((item) =>
              item.kind === "permission" && item.id === event.requestId
                ? { ...item, resolved: true }
                : item,
            );
          }
          default:
            return current;
        }
      });
      if (event.kind === "turn_completed" || event.kind === "turn_failed") {
        if (event.kind === "turn_failed" && event.error) {
          setNotice(event.error);
          onAction(t("Agent 回复失败：{0}", [event.error]));
        }
        setTurnActive(false);
      }
      if (event.kind === "panel_requested" && event.panel === "meeting-notes") {
        setPanel("meeting-notes");
      }
      if (event.kind === "closed") {
        setTurnActive(false);
        setSessionId(null);
        sessionIdRef.current = null;
      }
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else remove = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      remove?.();
    };
  }, [onAction]);

  useEffect(() => {
    return () => {
      const session = sessionIdRef.current;
      if (session) void finishAcpSession(session).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, sessionStarting]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || turnActive || sessionStarting) return;
    if (!sessionIdRef.current) {
      if (!providerId) {
        setNotice(t("没有可用的 Agent，请先安装并登录一个 Agent CLI"));
        return;
      }
      await startSession(providerId, text);
      setDraft("");
      return;
    }
    appendItem({ kind: "user", id: crypto.randomUUID(), text });
    setDraft("");
    setNotice(null);
    setTurnActive(true);
    try {
      await sendAcpPrompt(sessionIdRef.current, text);
    } catch (error) {
      setTurnActive(false);
      setNotice(t("发送失败：{0}", [String(error)]));
    }
  };

  const stop = async () => {
    const session = sessionIdRef.current;
    if (!session) return;
    try {
      await cancelAcpTurn(session);
    } catch {
      setTurnActive(false);
    }
  };

  const chooseProvider = async (next: string) => {
    if (next === providerId) return;
    setProviderId(next);
    const session = sessionIdRef.current;
    if (session) {
      sessionIdRef.current = null;
      setSessionId(null);
      setItems([]);
      setTurnActive(false);
      await finishAcpSession(session).catch(() => undefined);
    }
    await startSession(next);
  };

  const answerPermission = async (requestId: string, optionId?: string) => {
    const session = sessionIdRef.current;
    if (!session) return;
    try {
      await respondAcpPermission(session, requestId, optionId);
    } catch (error) {
      setNotice(t("无法回复授权请求：{0}", [String(error)]));
    }
  };

  return (
    <main className={`agent-chat-view${panel ? " with-panel" : ""}`}>
      <div className="agent-chat-main">
        <header className="agent-chat-header">
          <div className="agent-chat-identity">
            <span className="agent-chat-avatar">
              <Bot size={17} strokeWidth={1.8} />
            </span>
            <div>
              <strong>{t("Agent 对话")}</strong>
              <small>
                {sessionId
                  ? t("已连接 · {0}", [
                      activeProvider?.name ?? providerId ?? "",
                    ])
                  : sessionStarting
                    ? t("正在启动 Agent…")
                    : t("通过 ACP 连接本地编码 Agent")}
              </small>
            </div>
          </div>
          <label className="agent-chat-provider">
            <span>{t("Agent")}</span>
            <select
              value={providerId ?? ""}
              onChange={(event) => void chooseProvider(event.target.value)}
            >
              {providers.length === 0 && (
                <option value="">{t("未检测到")}</option>
              )}
              {providers.map((provider) => (
                <option
                  key={provider.id}
                  value={provider.id}
                  disabled={!provider.available}
                >
                  {provider.name}
                  {provider.available ? "" : ` · ${t("未安装")}`}
                </option>
              ))}
            </select>
          </label>
        </header>

        <div className="agent-chat-timeline" ref={scrollRef}>
          {items.length === 0 && !sessionStarting && (
            <div className="agent-chat-empty">
              <Bot size={30} strokeWidth={1.4} />
              <p>
                {t("和 {0} 聊聊任何开发问题，或让它帮你处理任务。", [
                  activeProvider?.name ?? "Agent",
                ])}
              </p>
            </div>
          )}
          {sessionStarting && (
            <div className="agent-chat-loading">
              <LoaderCircle className="agent-spin" size={16} />
              <span>{t("正在启动 Agent…")}</span>
            </div>
          )}
          {items.map((item) => {
            if (item.kind === "user") {
              return (
                <div className="agent-chat-bubble user" key={item.id}>
                  <p>{item.text}</p>
                </div>
              );
            }
            if (item.kind === "assistant") {
              return (
                <div className="agent-chat-bubble assistant" key={item.id}>
                  <span className="agent-chat-role">
                    <Bot size={13} /> {t("助手")}
                  </span>
                  <div className="agent-chat-markdown">
                    <Markdown>{item.text}</Markdown>
                  </div>
                </div>
              );
            }
            if (item.kind === "thought") {
              return (
                <div className="agent-chat-thought" key={item.id}>
                  <span className="agent-chat-role">
                    <Cpu size={13} /> {t("思考")}
                  </span>
                  <p>{item.text}</p>
                </div>
              );
            }
            if (item.kind === "tool") {
              const opensMeetingPanel = MEETING_TOOL_PATTERN.test(
                `${item.title} ${item.content ?? ""}`,
              );
              return (
                <div
                  className={`agent-chat-tool ${item.status}${opensMeetingPanel ? " panel-link" : ""}`}
                  key={item.id}
                  role={opensMeetingPanel ? "button" : undefined}
                  tabIndex={opensMeetingPanel ? 0 : undefined}
                  title={
                    opensMeetingPanel ? t("点击打开会议纪要面板") : undefined
                  }
                  onClick={
                    opensMeetingPanel
                      ? () => setPanel("meeting-notes")
                      : undefined
                  }
                  onKeyDown={
                    opensMeetingPanel
                      ? (event) => {
                          if (event.key !== "Enter" && event.key !== " ")
                            return;
                          event.preventDefault();
                          setPanel("meeting-notes");
                        }
                      : undefined
                  }
                >
                  <span className="agent-chat-role">
                    <Terminal size={13} /> {item.title}
                    <em>{item.status}</em>
                  </span>
                  {item.content && <pre>{item.content}</pre>}
                </div>
              );
            }
            if (item.kind === "plan") {
              return (
                <div className="agent-chat-plan" key={item.id}>
                  <span className="agent-chat-role">
                    <Cpu size={13} /> {t("计划")}
                  </span>
                  <ul>
                    {item.entries.map((entry, index) => (
                      <li
                        key={`${item.id}-${index}`}
                        className={entry.status === "completed" ? "done" : ""}
                      >
                        {entry.content}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }
            return (
              <div
                className={`agent-chat-permission${item.resolved ? " resolved" : ""}`}
                key={item.id}
              >
                <span className="agent-chat-role">
                  <ShieldQuestion size={13} /> {item.title || t("请求授权")}
                </span>
                {!item.resolved && (
                  <div className="agent-chat-permission-actions">
                    {item.options.map((option) => (
                      <button
                        type="button"
                        key={option.optionId}
                        className={
                          option.kind.startsWith("allow") ? "allow" : "deny"
                        }
                        onClick={() =>
                          void answerPermission(item.id, option.optionId)
                        }
                      >
                        {option.name}
                      </button>
                    ))}
                  </div>
                )}
                {item.resolved && <small>{t("已处理")}</small>}
              </div>
            );
          })}
          {turnActive && (
            <div className="agent-chat-typing">
              <span />
              <span />
              <span />
            </div>
          )}
          {notice && (
            <div className="agent-chat-notice" role="alert">
              {notice}
            </div>
          )}
        </div>

        <footer className="agent-chat-composer">
          <textarea
            rows={2}
            value={draft}
            placeholder={t("输入消息，Enter 发送，Shift+Enter 换行")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              )
                return;
              event.preventDefault();
              void submit();
            }}
          />
          <div className="agent-chat-actions">
            <span className="agent-chat-hint">
              {activeProvider
                ? t("会话运行在用户主目录")
                : t("选择一个 Agent 开始对话")}
            </span>
            {turnActive ? (
              <button
                type="button"
                className="stop"
                onClick={() => void stop()}
              >
                <CircleStop size={15} />
                {t("停止")}
              </button>
            ) : (
              <button
                type="button"
                className="send"
                disabled={!draft.trim() || sessionStarting}
                onClick={() => void submit()}
              >
                <Send size={15} />
                {t("发送")}
              </button>
            )}
          </div>
        </footer>
      </div>

      {panel === "meeting-notes" && (
        <aside className="agent-chat-panel">
          <header className="agent-chat-panel-header">
            <span>
              <NotebookPen size={14} /> {t("会议纪要")}
            </span>
            <button
              type="button"
              onClick={() => setPanel(null)}
              aria-label={t("关闭面板")}
            >
              <X size={15} />
            </button>
          </header>
          <div className="agent-chat-panel-body">
            <Suspense
              fallback={
                <div className="agent-chat-panel-loading">
                  <LoaderCircle className="agent-spin" size={16} />
                </div>
              }
            >
              <MeetingNotesView
                key={sessionId ?? "standalone"}
                initialInstruction=""
                models={models}
                onRunText={onRunText}
                onRunAudio={onRunAudio}
                onOpenStore={onOpenStore}
                onAction={onAction}
                panelMode
                bridgeSessionId={sessionId ?? undefined}
              />
            </Suspense>
          </div>
        </aside>
      )}
    </main>
  );
}
