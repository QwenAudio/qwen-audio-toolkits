import { isTauri } from "@tauri-apps/api/core";
import { invoke } from "./trace/ipcBridge";
import type { AcpModelCatalog } from '../domain/acpModels';
import { listen, type UnlistenFn } from "./trace/ipcBridge";
import type {
  AcpProviderInfo,
  AcpSessionEvent,
  AcpSessionStartRequest,
  AcpSessionStartResponse,
  OpenCodeConnection,
} from "../types";

export function listOpenCodeConnections(): Promise<OpenCodeConnection[]> {
  return invoke<OpenCodeConnection[]>("harness_list_opencode_connections");
}

export function listOpenCodeModels(providerId: string): Promise<string[]> {
  return invoke<string[]>("harness_list_opencode_models", { providerId });
}

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

export interface AcpModelInspectionTransport {
  listOpenCodeModels(providerId: string): Promise<string[]>
  start(request: AcpSessionStartRequest): Promise<AcpSessionStartResponse>
  finish(sessionId: string): Promise<void>
}

const acpModelInspectionTransport: AcpModelInspectionTransport = {
  listOpenCodeModels,
  start: startAcpSession,
  finish: finishAcpSession,
}

export async function inspectAcpModels(
  provider: AcpProviderInfo,
  apiProviderId?: string,
  transport: AcpModelInspectionTransport = acpModelInspectionTransport,
): Promise<AcpModelCatalog> {
  const configuredApiProviderId = apiProviderId?.trim()
  if (provider.requiresApiProvider) {
    if (!configuredApiProviderId) return { models: [], currentModelId: null }
    const models = await transport.listOpenCodeModels(configuredApiProviderId)
    return { models: models.map(id => ({ id, name: id })), currentModelId: null }
  }
  if (!isTauri()) {
    if (!import.meta.env.DEV) throw new Error('请在桌面端或本地开发预览中读取 ACP 模型。');
    return localAcpRequest<AcpModelCatalog>(`/models?provider=${encodeURIComponent(provider.id)}`);
  }
  const session = await transport.start({ providerId: provider.id, enableTools: false });
  try {
    return { models: session.modelOptions ?? session.models.map(id => ({ id, name: id })), currentModelId: session.currentModelId ?? null };
  } finally { await transport.finish(session.sessionId); }
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
