import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AcpModelCatalog } from '../domain/acpModels';
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AcpProviderInfo,
  AcpSessionEvent,
  AcpSessionStartRequest,
  AcpSessionStartResponse,
} from "../types";

export function listAcpProviders(): Promise<AcpProviderInfo[]> {
  if (!isTauri() && import.meta.env.DEV) return localAcpRequest<AcpProviderInfo[]>('/providers');
  return invoke<AcpProviderInfo[]>("acp_list_providers");
}

async function localAcpRequest<T>(path: string): Promise<T> {
  const response = await fetch(`/__local/acp${path}`, { headers: { 'X-QwenAudio-Local': '1' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'ACP connection failed');
  return data as T;
}

export async function inspectAcpModels(providerId: string): Promise<AcpModelCatalog> {
  if (!isTauri()) {
    if (!import.meta.env.DEV) throw new Error('请在桌面端或本地开发预览中读取 ACP 模型。');
    return localAcpRequest<AcpModelCatalog>(`/models?provider=${encodeURIComponent(providerId)}`);
  }
  const session = await startAcpSession({ providerId, enableTools: false });
  try {
    return { models: session.modelOptions ?? session.models.map(id => ({ id, name: id })), currentModelId: session.currentModelId ?? null };
  } finally { await finishAcpSession(session.sessionId); }
}

export function startAcpSession(
  request: AcpSessionStartRequest,
): Promise<AcpSessionStartResponse> {
  return invoke<AcpSessionStartResponse>("acp_start_session", { request });
}

export function sendAcpPrompt(
  sessionId: string,
  prompt: string,
): Promise<void> {
  return invoke<void>("acp_send_prompt", { sessionId, prompt });
}

export function cancelAcpTurn(sessionId: string): Promise<void> {
  return invoke<void>("acp_cancel_turn", { sessionId });
}

export function respondAcpPermission(
  sessionId: string,
  requestId: string,
  optionId?: string,
): Promise<void> {
  return invoke<void>("acp_respond_permission", {
    sessionId,
    requestId,
    optionId,
  });
}

export function finishAcpSession(sessionId: string): Promise<void> {
  return invoke<void>("acp_finish_session", { sessionId });
}

export interface MeetingStateSnapshot {
  recording: boolean;
  elapsedSeconds: number;
  updatedAt: number;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker: number | null;
  }>;
}

export function pushMeetingState(
  sessionId: string,
  snapshot: MeetingStateSnapshot,
): Promise<void> {
  return invoke<void>("agent_set_meeting_state", { sessionId, snapshot });
}

export function subscribeAcpSession(
  callback: (event: AcpSessionEvent) => void,
): Promise<UnlistenFn> {
  return listen<AcpSessionEvent>("acp-session-event", (event) =>
    callback(event.payload),
  );
}
