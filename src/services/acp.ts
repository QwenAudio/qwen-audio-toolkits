import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AcpProviderInfo,
  AcpSessionEvent,
  AcpSessionStartRequest,
  AcpSessionStartResponse,
} from "../types";

export function listAcpProviders(): Promise<AcpProviderInfo[]> {
  return invoke<AcpProviderInfo[]>("acp_list_providers");
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
