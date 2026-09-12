import { demoProjectSnapshot } from '../demo'
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ArrowDown,
  AudioLines,
  CircleStop,
  Clock3,
  FileText,
  LoaderCircle,
  Mic2,
  MonitorSpeaker,
  Network,
  RefreshCw,
  Sparkles,
  Store,
  Users,
} from "lucide-react";
import Markdown from "react-markdown";
import { t, useLocale } from "../i18n";
import { normalizeHarnessResult } from "../domain/results";
import {
  finishFunAsrStream,
  isTauriRuntime,
  pushFunAsrStream,
  startFunAsrStream,
  startSystemAudio,
  stopSystemAudio,
  subscribeFunAsrStream,
  subscribeSystemAudio,
} from "../services/harness";
import { pushMeetingState } from "../services/acp";
import { getMicrophoneStream } from "../services/audioCapture";
import { audioFileToClip, pcm16ChunksToWavFile } from "../utils/audio";
import { readMeetingSnapshot, type MeetingTurn } from "../domain/editorSnapshots";
import { readProjectSnapshot } from "../services/workspaceStorage";
import { useProjectAutosave } from "../hooks/useProjectAutosave";
import { useWorkspaceController } from "../hooks/useWorkspaceController";
import { assignMeetingSpeaker, meetingDetailView } from "../domain/meetingCommands";
import type {
  AsrTranscriptionResult,
  AudioClip,
  AudioProcessResult,
  HarnessExecution,
  ModelPlugin,
  TextGenerateResult,
  TtsGenerateResult,
  VadDetectionResult,
} from "../types";
import "./MeetingNotesView.css";

type MeetingSource = "microphone" | "system";

interface AudioChunk {
  pcmBase64: string;
  start: number;
  end: number;
}

interface SpeakerSegment {
  start: number;
  end: number;
  speaker: number;
}

interface MindMapNode {
  id: string;
  label: string;
  children: MindMapNode[];
}

interface MeetingNotesViewProps {
  projectId?: string;
  autoStart?: boolean;
  initialInstruction: string;
  models: ModelPlugin[];
  onGenerateText?: (prompt: string, systemPrompt: string) => Promise<string>;
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
  panelMode?: boolean;
  bridgeSessionId?: string;
}

const DIARIZATION_INTERVAL_SECONDS = 12;
const DIARIZATION_WINDOW_SECONDS = 36;
const SUMMARY_INTERVAL_SECONDS = 45;

function encodePcm16(
  samples: Float32Array,
  inputRate: number,
  outputRate = 16_000,
): string {
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < length; index += 1) {
    const sample =
      samples[Math.min(samples.length - 1, Math.floor(index * ratio))];
    view.setInt16(
      index * 2,
      Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff),
      true,
    );
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function overlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function outputText(
  output: TtsGenerateResult | TextGenerateResult | Record<string, unknown>,
): string {
  const text = (output as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
}

function markdownMindMap(markdown: string): MindMapNode {
  const root: MindMapNode = { id: "root", label: t("会议纪要"), children: [] };
  let current = root;
  markdown.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const node = {
        id: `heading-${index}`,
        label: heading[2].replace(/[*_`]/gu, ""),
        children: [],
      };
      root.children.push(node);
      current = node;
      return;
    }
    const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u.exec(line);
    const label = (item?.[1] ?? line).replace(/[*_`]/gu, "").trim();
    if (label)
      current.children.push({ id: `item-${index}`, label, children: [] });
  });
  if (!root.children.length && markdown.trim()) {
    root.children.push({ id: "content", label: markdown.trim(), children: [] });
  }
  return root;
}

function MindMapBranch({
  node,
  root = false,
}: {
  node: MindMapNode;
  root?: boolean;
}) {
  return (
    <div className={`meeting-mindmap-branch${root ? " root" : ""}`}>
      <div className="meeting-mindmap-node">{node.label}</div>
      {node.children.length > 0 && (
        <div className="meeting-mindmap-children">
          {node.children.map((child) => (
            <MindMapBranch key={child.id} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

export function MeetingNotesView({
  projectId,
  initialInstruction,
  models,
  onRunText,
  onGenerateText,
  onRunAudio,
  onOpenStore,
  onAction,
  panelMode,
  bridgeSessionId,
}: MeetingNotesViewProps) {
  useLocale();
  const [restored] = useState(() => readMeetingSnapshot(readProjectSnapshot(projectId, "meeting-notes") ?? demoProjectSnapshot(projectId)));
  const streamingAsr = useMemo(() => {
    const candidates = models.filter(
      (model) =>
        model.installed &&
        model.providerId &&
        model.streamingMode === "streaming" &&
        model.harnessCapabilities.includes("speech.transcribe"),
    );
    return (
      candidates.find((model) => model.adapter === "bailian-funasr") ??
      candidates.find((model) => model.adapter === "funasr-nano") ??
      candidates[0]
    );
  }, [models]);
  const diarizationModel = useMemo(
    () =>
      models.find(
        (model) =>
          model.installed &&
          model.providerId &&
          model.harnessCapabilities.includes("speaker.diarize"),
      ),
    [models],
  );
  const summaryModel = useMemo(
    () =>
      models.find(
        (model) =>
          model.installed &&
          model.providerId &&
          model.harnessCapabilities.includes("text.generate"),
      ),
    [models],
  );

  const [source, setSource] = useState<MeetingSource>(restored?.source ?? "microphone");
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [engineLoading, setEngineLoading] = useState(false);
  const [turns, setTurns] = useState<MeetingTurn[]>(restored?.turns ?? []);
  const [partialText, setPartialText] = useState("");
  const [elapsed, setElapsed] = useState(restored?.elapsed ?? 0);
  const [summary, setSummary] = useState(restored?.summary ?? "");
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryView, setSummaryView] = useState<"notes" | "mindmap">(restored?.summaryView ?? "notes");
  const [detailView, setDetailView] = useState<"transcript" | "summary">("transcript");
  const [showLatestButton, setShowLatestButton] = useState(false);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const followTranscriptRef = useRef(true);
  const [summaryUpdatedAt, setSummaryUpdatedAt] = useState<number | null>(restored?.summaryUpdatedAt ?? null);
  const [diarizationBusy, setDiarizationBusy] = useState(false);
  const [restoredRecording, setRestoredRecording] = useState(Boolean(restored && (restored.turns.length || restored.elapsed || restored.summary)));

  useProjectAutosave(projectId, "meeting-notes", useMemo(() => ({
    version: 1, source, turns, elapsed, summary, summaryView, summaryUpdatedAt,
    recording, stopping,
  }), [source, turns, elapsed, summary, summaryView, summaryUpdatedAt, recording, stopping]));

  const sessionRef = useRef<string | null>(null);
  const captureStateRef = useRef<"idle" | "starting" | "recording" | "stopping">("idle");
  const manuallyAssignedTurnsRef = useRef(new Set<string>());
  const systemSessionRef = useRef<string | null>(null);
  const systemUnlistenRef = useRef<(() => void) | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const pushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const audioChunksRef = useRef<AudioChunk[]>([]);
  const turnsRef = useRef<MeetingTurn[]>(restored?.turns ?? []);
  const bridgePushAtRef = useRef(0);
  const bridgeRecordingRef = useRef(false);
  const speakerTimelineRef = useRef<SpeakerSegment[]>([]);
  const nextSpeakerRef = useRef((restored?.turns ?? []).reduce((max, turn) => Math.max(max, turn.speaker ?? 0), 0) + 1);
  const meetingStartRef = useRef(0);
  const recordingOffsetRef = useRef(restored?.elapsed ?? 0);
  const captureRateRef = useRef(16_000);
  const nextDiarizationAtRef = useRef(DIARIZATION_INTERVAL_SECONDS);
  const diarizationBusyRef = useRef(false);
  const summaryBusyRef = useRef(false);
  const summarizedCharactersRef = useRef(0);
  const engineFinalTextRef = useRef("");
  const completedByUserRef = useRef(false);
  const completionResolverRef = useRef<(() => void) | null>(null);
  const onActionRef = useRef(onAction);
  const runDiarizationRef = useRef<(force?: boolean) => Promise<void>>(
    async () => undefined,
  );
  const summarizeRef = useRef<(final?: boolean) => Promise<boolean>>(
    async () => false,
  );
  const commitStableTextRef = useRef<(text: string) => void>(() => undefined);
  onActionRef.current = onAction;

  const updateTurns = (updater: (current: MeetingTurn[]) => MeetingTurn[]) => {
    setTurns((current) => {
      const next = updater(current);
      turnsRef.current = next;
      return next;
    });
  };

  const meetingSeconds = () =>
    meetingStartRef.current
      ? (performance.now() - meetingStartRef.current) / 1000
      : 0;

  const appendAudioChunk = (pcmBase64: string, duration: number) => {
    const end = meetingSeconds();
    const start = Math.max(0, end - duration);
    audioChunksRef.current.push({ pcmBase64, start, end });
    audioChunksRef.current = audioChunksRef.current.filter(
      (chunk) => chunk.end >= end - DIARIZATION_WINDOW_SECONDS - 4,
    );
  };

  const stopInputNodes = () => {
    if (processorRef.current) processorRef.current.onaudioprocess = null;
    processorRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    gainRef.current?.disconnect();
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    processorRef.current = null;
    sourceNodeRef.current = null;
    gainRef.current = null;
    microphoneRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
  };

  const applySpeakerWindow = (
    localSegments: Array<{ start: number; end: number; label: string }>,
    windowStart: number,
    windowEnd: number,
  ) => {
    const previous = speakerTimelineRef.current;
    const labels = [...new Set(localSegments.map((segment) => segment.label))];
    const mapping = new Map<string, number>();
    for (const label of labels) {
      const candidates = new Map<number, number>();
      localSegments
        .filter((segment) => segment.label === label)
        .forEach((segment) => {
          const absoluteStart = windowStart + segment.start;
          const absoluteEnd = windowStart + segment.end;
          previous.forEach((known) => {
            const score = overlap(
              absoluteStart,
              absoluteEnd,
              known.start,
              known.end,
            );
            if (score > 0)
              candidates.set(
                known.speaker,
                (candidates.get(known.speaker) ?? 0) + score,
              );
          });
        });
      const best = [...candidates.entries()].sort(
        (left, right) => right[1] - left[1],
      )[0];
      if (best && best[1] >= 0.8) mapping.set(label, best[0]);
    }
    labels.forEach((label) => {
      if (!mapping.has(label)) {
        mapping.set(label, nextSpeakerRef.current);
        nextSpeakerRef.current += 1;
      }
    });
    const absoluteSegments = localSegments.map((segment) => ({
      start: windowStart + segment.start,
      end: windowStart + segment.end,
      speaker: mapping.get(segment.label) ?? 1,
    }));
    speakerTimelineRef.current = [
      ...previous.filter(
        (segment) => segment.end < windowStart || segment.start > windowEnd,
      ),
      ...absoluteSegments,
    ].sort((left, right) => left.start - right.start);

    updateTurns((current) =>
      current.map((turn) => {
        if (manuallyAssignedTurnsRef.current.has(turn.id)) return turn;
        if (turn.end < windowStart || turn.start > windowEnd) return turn;
        const best = absoluteSegments
          .map((segment) => ({
            segment,
            score: overlap(turn.start, turn.end, segment.start, segment.end),
          }))
          .sort((left, right) => right.score - left.score)[0];
        return best && best.score > 0
          ? { ...turn, speaker: best.segment.speaker }
          : turn;
      }),
    );
  };

  const runRollingDiarization = async (force = false) => {
    if (!diarizationModel?.providerId || diarizationBusyRef.current) return;
    const now = meetingSeconds();
    if (!force && now < nextDiarizationAtRef.current) return;
    const chunks = audioChunksRef.current.filter(
      (chunk) => chunk.end >= Math.max(0, now - DIARIZATION_WINDOW_SECONDS),
    );
    if (!chunks.length || chunks.at(-1)!.end - chunks[0].start < 4) return;
    nextDiarizationAtRef.current = now + DIARIZATION_INTERVAL_SECONDS;
    diarizationBusyRef.current = true;
    setDiarizationBusy(true);
    const windowStart = chunks[0].start;
    const windowEnd = chunks.at(-1)!.end;
    try {
      const file = pcm16ChunksToWavFile(
        chunks.map((chunk) => chunk.pcmBase64),
        captureRateRef.current,
        `meeting-speakers-${Date.now()}.wav`,
      );
      const clip = await audioFileToClip(file);
      const execution = await onRunAudio(
        clip,
        "speaker.diarize",
        diarizationModel.providerId,
        diarizationModel.version,
        {},
        false,
      );
      const normalized = normalizeHarnessResult(execution.output);
      applySpeakerWindow(normalized.segments, windowStart, windowEnd);
      if (clip.url) URL.revokeObjectURL(clip.url);
    } catch (error) {
      onAction(
        t("说话人识别暂时失败：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    } finally {
      diarizationBusyRef.current = false;
      setDiarizationBusy(false);
    }
  };

  const summarize = async (final = false) => {
    if ((!onGenerateText && !summaryModel?.providerId) || summaryBusyRef.current) return false;
    const transcript = turnsRef.current
      .map(
        (turn) =>
          `${formatElapsed(turn.start)} 说话人 ${turn.speaker ?? "待识别"}：${turn.text}`,
      )
      .join("\n");
    if (!transcript.trim()) return false;
    if (!final && transcript.length - summarizedCharactersRef.current < 80)
      return false;
    summaryBusyRef.current = true;
    setSummaryBusy(true);
    try {
      const request = [
        "你是实时会议纪要助手。请只根据下面已经稳定的转写更新滚动纪要。",
        "使用简洁 Markdown，固定包含：当前结论、讨论要点、行动项、待确认问题。",
        "行动项尽量写明负责人和时间；未明确的信息标注“待确认”，不要猜测。",
        final
          ? "这是会议结束后的最终版本，请合并重复内容并形成可直接分享的纪要。"
          : "这是会议中的阶段版本，保留仍在讨论中的不确定性。",
        initialInstruction.trim()
          ? `用户关注重点：${initialInstruction.trim()}`
          : "",
        `会议转写：\n${transcript}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const next = onGenerateText ? await onGenerateText(request, '根据已提供的会议转写生成纪要，不添加未经证实的信息。')
        : await (async () => {
      const execution = await onRunText(
        request,
        "text.generate",
        summaryModel!.providerId!,
        summaryModel!.version,
        { temperature: 0.2, maxTokens: final ? 1600 : 1000 },
        [],
        false,
      );
      return outputText(execution.output);
        })();
      if (next) {
        setSummary(next);
        setSummaryUpdatedAt(Date.now());
        summarizedCharactersRef.current = transcript.length;
        return true;
      }
      return false;
    } catch (error) {
      onAction(
        t("会议纪要更新失败：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
      return false;
    } finally {
      summaryBusyRef.current = false;
      setSummaryBusy(false);
    }
  };
  const commitStableText = (stableText: string) => {
    const stable = stableText.trim();
    const previous = engineFinalTextRef.current.trim();
    if (!stable || stable === previous) return;
    const delta = stable.startsWith(previous)
      ? stable.slice(previous.length).trim()
      : stable;
    engineFinalTextRef.current = stable;
    const additions = delta
      .split(/\n+/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!additions.length) return;
    const end = meetingSeconds();
    const firstStart = Math.max(recordingOffsetRef.current,
      turnsRef.current.at(-1)?.end ?? Math.max(0, end - additions.length * 3));
    const duration = Math.max(0.1, end - firstStart) / additions.length;
    updateTurns((current) => [
      ...current,
      ...additions.map((text, index) => ({
        id: crypto.randomUUID(),
        text,
        start: firstStart + duration * index,
        end: firstStart + duration * (index + 1),
        speaker: null,
      })),
    ]);
    void runDiarizationRef.current();
  };
  runDiarizationRef.current = runRollingDiarization;
  summarizeRef.current = summarize;
  commitStableTextRef.current = commitStableText;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let remove: (() => void) | undefined;
    let disposed = false;
    void subscribeFunAsrStream((event) => {
      if (event.sessionId !== sessionRef.current) return;
      if (event.kind === "partial") {
        setEngineLoading(false);
        const lineBoundary = event.text.lastIndexOf("\n");
        const punctuationMatches = [
          ...event.text.matchAll(/[。！？.!?](?=\s|$)/gu),
        ];
        const punctuationBoundary = punctuationMatches.at(-1)?.index;
        const stableBoundary = Math.max(
          lineBoundary,
          punctuationBoundary === undefined ? -1 : punctuationBoundary + 1,
        );
        if (stableBoundary > 0) {
          commitStableTextRef.current(event.text.slice(0, stableBoundary));
        }
        const committed = engineFinalTextRef.current;
        const text = event.text.startsWith(committed)
          ? event.text.slice(committed.length).trim()
          : event.text.slice(Math.max(0, stableBoundary)).trim();
        setPartialText(text);
        return;
      }
      if (event.kind === "final") {
        setEngineLoading(false);
        commitStableTextRef.current(event.text);
        setPartialText("");
        return;
      }
      if (event.kind === "error") {
        completionResolverRef.current?.();
        completionResolverRef.current = null;
        setEngineLoading(false);
        setRecording(false);
        stopInputNodes();
        if (systemSessionRef.current) void stopSystemAudio(systemSessionRef.current).catch(() => undefined);
        systemUnlistenRef.current?.();
        systemUnlistenRef.current = null;
        systemSessionRef.current = null;
        sessionRef.current = null;
        if (captureStateRef.current !== "starting" && captureStateRef.current !== "stopping") captureStateRef.current = "idle";
        onActionRef.current(event.error || t("实时识别失败"));
      } else if (event.kind === "completed" && !completedByUserRef.current) {
        completionResolverRef.current?.();
        completionResolverRef.current = null;
        setEngineLoading(false);
        setRecording(false);
        stopInputNodes();
        if (systemSessionRef.current) void stopSystemAudio(systemSessionRef.current).catch(() => undefined);
        systemUnlistenRef.current?.();
        systemUnlistenRef.current = null;
        systemSessionRef.current = null;
        sessionRef.current = null;
        if (captureStateRef.current !== "starting") captureStateRef.current = "idle";
      } else if (event.kind === "completed") {
        completionResolverRef.current?.();
        completionResolverRef.current = null;
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else remove = unlisten;
    }).catch(error => {
      if (!disposed) onActionRef.current(error instanceof Error ? error.message : String(error));
    });
    return () => {
      disposed = true;
      remove?.();
    };
  }, []);

  useEffect(() => {
    if (!recording) return undefined;
    const timer = window.setInterval(() => {
      const seconds = meetingSeconds();
      setElapsed(seconds);
      if (seconds >= nextDiarizationAtRef.current)
        void runDiarizationRef.current();
      if (
        Math.floor(seconds) > 0 &&
        Math.floor(seconds) % SUMMARY_INTERVAL_SECONDS === 0
      ) {
        void summarizeRef.current();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (!bridgeSessionId) return;
    const now = Date.now();
    const recordingChanged = recording !== bridgeRecordingRef.current;
    if (!recordingChanged && now - bridgePushAtRef.current < 1500) return;
    bridgeRecordingRef.current = recording;
    bridgePushAtRef.current = now;
    void pushMeetingState(bridgeSessionId, {
      recording,
      elapsedSeconds: elapsed,
      updatedAt: now,
      segments: turns.map((turn) => ({
        start: turn.start,
        end: turn.end,
        text: turn.text,
        speaker: turn.speaker,
      })),
    }).catch(() => undefined);
  }, [bridgeSessionId, recording, turns, elapsed]);

  const startMeeting = async () => {
    if (captureStateRef.current !== "idle") throw new Error(t("会议记录正在启动、进行或结束中，请稍后再试。"));
    if (!streamingAsr?.providerId) {
      throw new Error(t("请先安装一个流式语音识别模型"));
    }
    if (!isTauriRuntime()) throw new Error(t("请在桌面应用中开始会议录音。"));
    captureStateRef.current = "starting";
    setStarting(true);
    try {
      completedByUserRef.current = false;
      recordingOffsetRef.current = elapsed;
      // Audio is a new capture; append text to the saved meeting without claiming voice identity continuity.
      speakerTimelineRef.current = [];
      meetingStartRef.current = performance.now() - elapsed * 1000;
      nextDiarizationAtRef.current = elapsed + DIARIZATION_INTERVAL_SECONDS;
      audioChunksRef.current = [];
      pushQueueRef.current = Promise.resolve();
      engineFinalTextRef.current = "";
      const sampleRate = source === "system" ? 48_000 : 16_000;
      captureRateRef.current = sampleRate;
      const started = await startFunAsrStream({
        clipName: t("会议记录-{0}", [Date.now()]),
        providerId: streamingAsr.providerId,
        modelId: streamingAsr.version,
        sampleRate,
        language: "auto",
        semanticPunctuation: true,
        context: initialInstruction,
      });
      sessionRef.current = started.sessionId;
      setEngineLoading(true);

      if (source === "system") {
        systemUnlistenRef.current = await subscribeSystemAudio((chunk) => {
          if (
            chunk.sessionId !== systemSessionRef.current ||
            !sessionRef.current
          )
            return;
          const duration = atob(chunk.pcmBase64).length / 2 / chunk.sampleRate;
          appendAudioChunk(chunk.pcmBase64, duration);
          pushQueueRef.current = pushQueueRef.current.then(() =>
            pushFunAsrStream(sessionRef.current!, chunk.pcmBase64),
          );
        });
        const system = await startSystemAudio(false);
        systemSessionRef.current = system.sessionId;
      } else {
        const stream = await getMicrophoneStream({
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        });
        microphoneRef.current = stream;
        const context = new AudioContext({ latencyHint: "interactive" });
        contextRef.current = context;
        await context.resume();
        const input = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(4096, 1, 1);
        const gain = context.createGain();
        gain.gain.value = 0;
        processor.onaudioprocess = (event) => {
          const sessionId = sessionRef.current;
          if (!sessionId) return;
          const pcmBase64 = encodePcm16(
            event.inputBuffer.getChannelData(0),
            context.sampleRate,
          );
          const duration = atob(pcmBase64).length / 2 / 16_000;
          appendAudioChunk(pcmBase64, duration);
          pushQueueRef.current = pushQueueRef.current.then(() =>
            pushFunAsrStream(sessionId, pcmBase64),
          );
        };
        input.connect(processor);
        processor.connect(gain);
        gain.connect(context.destination);
        contextRef.current = context;
        sourceNodeRef.current = input;
        processorRef.current = processor;
        gainRef.current = gain;
      }
      if (sessionRef.current !== started.sessionId) throw new Error(t("实时识别会话已结束，请重新开始记录。"));
      captureStateRef.current = "recording";
      setRecording(true);
      setRestoredRecording(false);
      return { message: t("会议记录已开始") };
    } catch (error) {
      stopInputNodes();
      if (systemSessionRef.current)
        void stopSystemAudio(systemSessionRef.current).catch(() => undefined);
      systemUnlistenRef.current?.();
      systemUnlistenRef.current = null;
      if (sessionRef.current) void finishFunAsrStream(sessionRef.current).catch(() => undefined);
      sessionRef.current = null;
      systemSessionRef.current = null;
      captureStateRef.current = "idle";
      setEngineLoading(false);
      throw new Error(
        t("无法开始会议记录：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    } finally {
      setStarting(false);
    }
  };

  const stopMeeting = async () => {
    const sessionId = sessionRef.current;
    if (!sessionId || captureStateRef.current !== "recording") throw new Error(t("当前没有可结束的会议录音。"));
    captureStateRef.current = "stopping";
    setStopping(true);
    setRecording(false);
    completedByUserRef.current = true;
    stopInputNodes();
    try {
      if (systemSessionRef.current)
        await stopSystemAudio(systemSessionRef.current);
      systemUnlistenRef.current?.();
      systemUnlistenRef.current = null;
      systemSessionRef.current = null;
      await pushQueueRef.current;
      const completed = new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => {
          completionResolverRef.current = null;
          resolve();
        }, 5000);
        completionResolverRef.current = () => {
          window.clearTimeout(timeout);
          resolve();
        };
      });
      await finishFunAsrStream(sessionId);
      await completed;
      await runRollingDiarization(true);
      const summarized = await summarize(true);
      return { message: summarized ? t("会议记录已结束，最终纪要已更新。") : t("会议录音已结束，当前转写和已有纪要已保留；尚未生成新的最终纪要。") };
    } catch (error) {
      throw new Error(
        t("结束会议记录失败：{0}", [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    } finally {
      sessionRef.current = null;
      captureStateRef.current = "idle";
      setStopping(false);
      setEngineLoading(false);
    }
  };

  const showMeetingView = (view: unknown) => {
    const next = meetingDetailView(view);
    flushSync(() => setDetailView(next));
    return { message: next === "summary" ? t("右侧已切换到会议总结。") : t("右侧已切换到实时转写。") };
  };

  const maximumSpeaker = Math.max(2, nextSpeakerRef.current - 1);
  const setMeetingSpeaker = (turnId: unknown, speaker: unknown) => {
    // Validate before mutating; manual correction must survive later diarization updates.
    assignMeetingSpeaker(turnsRef.current, turnId, speaker, maximumSpeaker);
    manuallyAssignedTurnsRef.current.add(turnId as string);
    flushSync(() => updateTurns(current => assignMeetingSpeaker(current, turnId, speaker, maximumSpeaker)));
    return { message: t("已将这段发言归为说话人 {0}。", [speaker as number]) };
  };

  const reportCapture = async (operation: () => Promise<{ message: string }>) => {
    try {
      onAction((await operation()).message);
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    }
  };

  useWorkspaceController(projectId, {
    getState: () => ({
      mode: "meeting-notes",
      presentation: {
        hasArtifact: Boolean(turns.length || partialText || summary), busy: recording || starting || stopping || summaryBusy,
        message: recording ? t('正在记录会议…') : turns.length ? t('会议记录已更新，可在右侧查看。') : '',
        issue: !recording && !turns.length ? t('请在对话中告诉我开始记录会议，以及使用麦克风还是电脑音频。') : '',
      },
      busy: captureStateRef.current !== "idle" || summaryBusyRef.current,
      revision: JSON.stringify([turns, summary, source, detailView, summaryView, recording, starting, stopping]),
      context: {
        instruction: initialInstruction, source, recording, starting, stopping,
        elapsedSeconds: elapsed, turns, partialText, summary, summaryBusy, summaryUpdatedAt,
        detailView, summaryView, maximumSpeaker,
        models: { streamingAsr: streamingAsr?.name ?? null, diarization: diarizationModel?.name ?? null, summary: summaryModel?.name ?? null },
      },
      actions: [
        {
          name: "meeting.show-view", description: "切换右侧会议面板，查看当前实时转写或已有会议总结；此操作不会生成新总结。",
          parameters: { type: "object", properties: { view: { type: "string", enum: ["transcript", "summary"] } }, required: ["view"], additionalProperties: false },
          allowedWhileBusy: true,
          quickCommands: [
            { text: "查看会议总结", args: { view: "summary" } }, { text: "查看实时转写", args: { view: "transcript" } },
            { text: "Show meeting summary", args: { view: "summary" } }, { text: "Show live transcript", args: { view: "transcript" } },
          ],
        },
        {
          name: "meeting.set-speaker", description: "校正指定发言的说话人，与右侧手动校正使用同一状态。turnId 必须取自当前 turns，speaker 必须为已有范围内的整数。",
          parameters: { type: "object", properties: { turnId: { type: "string" }, speaker: { type: "integer", minimum: 1, maximum: maximumSpeaker } }, required: ["turnId", "speaker"], additionalProperties: false },
          allowedWhileBusy: true,
        },
        {
          name: "meeting.start", description: "仅当用户明确要求开始录音时，使用当前音频来源启动会议录音与实时识别；恢复的会议会续写，不会自动重新录制。",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          quickCommands: [{ text: "开始会议录音", args: {} }],
        },
        {
          name: "meeting.stop", description: "结束当前会议录音，等待剩余转写处理，并尝试生成最终纪要；返回实际结果。",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          allowedWhileBusy: true,
          quickCommands: [{ text: "结束会议录音", args: {} }, { text: "结束会议", args: {} }],
        },
      ],
    }),
    execute: async command => {
      if (command.action === "meeting.show-view") {
        if (Object.keys(command.args).some(key => key !== "view")) throw new Error(t("会议操作参数无效。"));
        return showMeetingView(command.args.view);
      }
      if (command.action === "meeting.set-speaker") {
        if (Object.keys(command.args).some(key => !["turnId", "speaker"].includes(key))) throw new Error(t("会议操作参数无效。"));
        return setMeetingSpeaker(command.args.turnId, command.args.speaker);
      }
      if (Object.keys(command.args).length) throw new Error(t("会议操作参数无效。"));
      if (command.action === "meeting.start") return startMeeting();
      if (command.action === "meeting.stop") return stopMeeting();
      throw new Error(t("不支持的会议操作。"));
    },
  });

  useEffect(
    () => () => {
      stopInputNodes();
      systemUnlistenRef.current?.();
      if (systemSessionRef.current)
        void stopSystemAudio(systemSessionRef.current);
      if (sessionRef.current) void finishFunAsrStream(sessionRef.current);
    },
    [],
  );

  const missing = [
    !streamingAsr && t("流式识别"),
    !diarizationModel && t("说话人识别"),
    !onGenerateText && !summaryModel && t("文本总结"),
  ].filter(Boolean) as string[];
  const mindMap = useMemo(() => markdownMindMap(summary), [summary]);

  useEffect(() => {
    const viewport = transcriptScrollRef.current;
    if (!viewport || !followTranscriptRef.current || (panelMode && detailView !== "transcript")) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [turns, partialText, engineLoading, detailView, panelMode]);

  return (
    <main className={`meeting-notes-view${panelMode ? " panel-mode" : ""}`}>
      <header className="meeting-notes-header">
        <div>
          <span>
            <Sparkles size={14} /> {t("实时会议纪要")}
          </span>
          <h1>{initialInstruction || t("新会议")}</h1>
        </div>
        <div className="meeting-status-cluster">
          <span className={recording ? "recording" : ""}>
            <i />{" "}
            {recording ? t("记录中") : starting ? t("正在启动录音…") : stopping ? t("正在整理") : turns.length || summary ? t("记录已暂停") : t("尚未开始")}
          </span>
          <strong>{formatElapsed(elapsed)}</strong>
        </div>
      </header>

      {restoredRecording && (
        <p className="meeting-restored-note" role="status">
          {t("已恢复转写和纪要，录音已停止。开始新录音后会续写到此会议，之前的音频未保存。")}
        </p>
      )}

      <div className="meeting-toolbar">
        <div className="meeting-source-picker" aria-label={t("会议音频来源")}>
          <button
            type="button"
            className={source === "microphone" ? "active" : ""}
            disabled={recording || starting || stopping}
            onClick={() => setSource("microphone")}
          >
            <Mic2 size={15} /> {t("麦克风")}
          </button>
          <button
            type="button"
            className={source === "system" ? "active" : ""}
            disabled={recording || starting || stopping}
            onClick={() => setSource("system")}
          >
            <MonitorSpeaker size={15} /> {t("电脑音频")}
          </button>
        </div>
        {missing.length > 0 ? (
          <button
            type="button"
            className="meeting-store-button"
            onClick={onOpenStore}
          >
            <Store size={15} /> {t("安装所需模型")} · {missing.join(" / ")}
          </button>
        ) : recording ? (
          <button
            type="button"
            className="meeting-stop-button"
            onClick={() => void reportCapture(stopMeeting)}
          >
            <CircleStop size={16} /> {t("结束会议")}
          </button>
        ) : (
          <button
            type="button"
            className="meeting-start-button"
            disabled={starting || stopping}
            onClick={() => void reportCapture(startMeeting)}
          >
            {starting || stopping ? (
              <LoaderCircle className="model-spin" size={16} />
            ) : (
              <AudioLines size={16} />
            )}
            {starting ? t("正在启动录音…") : stopping
              ? t("正在生成最终纪要")
              : turns.length
                ? t("开始新录音并续写")
                : t("开始记录")}
          </button>
        )}
      </div>

      {panelMode && (
        <div className="meeting-detail-switch" role="group" aria-label={t("会议内容")}>
          <button
            type="button"
            aria-pressed={detailView === "transcript"}
            className={detailView === "transcript" ? "active" : ""}
            onClick={() => showMeetingView("transcript")}
          >
            <AudioLines size={15} /> {t("实时转写")}
            {turns.length > 0 && <span>{turns.length}</span>}
          </button>
          <button
            type="button"
            aria-pressed={detailView === "summary"}
            className={detailView === "summary" ? "active" : ""}
            onClick={() => showMeetingView("summary")}
          >
            {summaryBusy ? <LoaderCircle className="model-spin" size={15} /> : <Sparkles size={15} />}
            {t("会议总结")}
          </button>
        </div>
      )}

      <div className={`meeting-panels detail-${detailView}`}>
        <section className="meeting-transcript-panel">
          <header>
            <div>
              <Users size={16} />
              <strong>{t("实时转写")}</strong>
            </div>
            <span>
              {diarizationBusy ? (
                <>
                  <LoaderCircle className="model-spin" size={12} />{" "}
                  {t("正在更新说话人")}
                </>
              ) : (
                t("说话人约延迟 10–15 秒")
              )}
            </span>
          </header>
          <div
            className="meeting-transcript-scroll"
            ref={transcriptScrollRef}
            onScroll={(event) => {
              const viewport = event.currentTarget;
              const nearLatest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64;
              followTranscriptRef.current = nearLatest;
              setShowLatestButton(!nearLatest);
            }}
          >
            {!turns.length && !partialText ? (
              <div className="meeting-empty-state">
                <Mic2 size={26} />
                <strong>{t("发言内容会实时显示在这里")}</strong>
                <span>{t("说话人标签会在短暂分析后原位更新")}</span>
              </div>
            ) : (
              <>
                {turns.map((turn) => (
                  <article className="meeting-turn" key={turn.id}>
                    <button
                      type="button"
                      className={turn.speaker ? "" : "pending"}
                      title={t("点击可手动校正说话人")}
                      onClick={() => setMeetingSpeaker(turn.id, ((turn.speaker ?? 0) % maximumSpeaker) + 1)}
                    >
                      {turn.speaker
                        ? t("说话人 {0}", [turn.speaker])
                        : t("识别中")}
                    </button>
                    <div>
                      <time>{formatElapsed(turn.start)}</time>
                      <p>{turn.text}</p>
                    </div>
                  </article>
                ))}
                {(partialText || engineLoading) && (
                  <article className="meeting-turn partial">
                    <span className="pending">{t("实时")}</span>
                    <div>
                      <time>{formatElapsed(elapsed)}</time>
                      <p>{partialText || t("识别引擎加载中…")}</p>
                    </div>
                  </article>
                )}
              </>
            )}
          </div>
          {showLatestButton && (
            <button
              type="button"
              className="meeting-latest-button"
              onClick={() => {
                followTranscriptRef.current = true;
                setShowLatestButton(false);
                const viewport = transcriptScrollRef.current;
                if (viewport) viewport.scrollTop = viewport.scrollHeight;
              }}
            >
              <ArrowDown size={13} /> {t("回到最新发言")}
            </button>
          )}
        </section>

        <section className="meeting-summary-panel">
          <header>
            <div>
              <Sparkles size={16} />
              <strong>{t("滚动纪要")}</strong>
            </div>
            <div className="meeting-summary-header-actions">
              {summary && (
                <div
                  className="meeting-summary-view-switch"
                  aria-label={t("纪要视图")}
                >
                  <button
                    type="button"
                    className={summaryView === "notes" ? "active" : ""}
                    onClick={() => setSummaryView("notes")}
                    title={t("Markdown 纪要")}
                  >
                    <FileText size={13} />
                  </button>
                  <button
                    type="button"
                    className={summaryView === "mindmap" ? "active" : ""}
                    onClick={() => setSummaryView("mindmap")}
                    title={t("思维导图")}
                  >
                    <Network size={13} />
                  </button>
                </div>
              )}
              <span>
                {summaryBusy ? (
                  <>
                    <LoaderCircle className="model-spin" size={12} />{" "}
                    {t("正在更新")}
                  </>
                ) : summaryUpdatedAt ? (
                  <>
                    <Clock3 size={12} /> {t("刚刚已更新")}
                  </>
                ) : (
                  t("约每 45 秒更新")
                )}
              </span>
            </div>
          </header>
          <div className="meeting-summary-content">
            {summary ? (
              summaryView === "notes" ? (
                <article className="meeting-markdown">
                  <Markdown>{summary}</Markdown>
                </article>
              ) : (
                <div className="meeting-mindmap">
                  <MindMapBranch node={mindMap} root />
                </div>
              )
            ) : (
              <div className="meeting-empty-state summary">
                <RefreshCw size={24} />
                <strong>{t("纪要会在内容稳定后出现")}</strong>
                <span>{t("右侧会持续整理结论、要点、行动项和待确认问题")}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
