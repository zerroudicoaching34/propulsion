import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Meeting, Prospect, Segment } from "../core/types";

// Typed bridge to the Rust backend. Every call goes through Tauri IPC; there is no
// other network access from the web view (see the CSP in tauri.conf.json).

export interface CloudProvider {
  kind: "anthropic" | "openai_compatible";
  label: string;
  baseUrl: string;
  model: string;
}

export interface AppSettings {
  aiMode: "local" | "hybrid" | "deep";
  ollamaUrl: string;
  ollamaModel: string;
  llmEnabled: boolean;
  llmIntervalSec: number;
  whisperModelPath: string;
  whisperThreads: number;
  inputDevice: string;
  retentionDays: number;
  retainByDefault: boolean;
  cloud: CloudProvider;
  showDiscGrid: boolean;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  keyStorage: "keychain" | "file";
  databaseEncrypted: boolean;
  schemaVersion: number;
  whisperCompiled: boolean;
  os: string;
  arch: string;
}

export type AudioStateName = "idle" | "loading_model" | "listening" | "paused" | "error";
export interface AudioStatus {
  state: AudioStateName;
  meetingId: string | null;
  speaker: string;
  device: string | null;
  message: string | null;
  pendingChunks: number;
}

export interface OllamaStatus {
  reachable: boolean;
  models: string[];
  configuredModelAvailable: boolean;
  message: string | null;
}

export interface CloudTransfer {
  id: string;
  meetingId: string | null;
  provider: string;
  model: string;
  purpose: string;
  bytes: number;
  sha256: string;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface CloudResult {
  id: string;
  meetingId: string;
  transferId: string;
  provider: string;
  model: string;
  content: string;
  createdAt: string;
}

export interface MeetingPatch {
  scheduledAt?: string;
  type?: "R1" | "R2";
  status?: Meeting["status"];
  retain?: boolean;
  decision?: string;
  nextAction?: string;
  objectionKinds?: string;
  coverageCovered?: number;
  coverageTotal?: number;
  analysisJson?: string;
  debriefJson?: string;
}

/** Meeting as stored (adds non-content metadata kept for statistics). */
export interface StoredMeeting extends Meeting {
  objectionKinds: string;
  coverageCovered: number;
  coverageTotal: number;
  analysisJson: string | null;
  contentPurged: boolean;
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsSet: (value: AppSettings) => invoke<AppSettings>("settings_set", { value }),
  kbGet: (key: string) => invoke<string | null>("kb_get", { key }),
  kbSet: (key: string, value: string) => invoke<void>("kb_set", { key, value }),

  prospectList: () => invoke<Prospect[]>("prospect_list"),
  prospectGet: (id: string) => invoke<Prospect | null>("prospect_get", { id }),
  prospectUpsert: (prospect: Partial<Prospect>) => invoke<Prospect>("prospect_upsert", { prospect }),
  prospectDelete: (id: string) => invoke<void>("prospect_delete", { id }),

  meetingList: (prospectId?: string) => invoke<StoredMeeting[]>("meeting_list", { prospectId: prospectId ?? null }),
  meetingGet: (id: string) => invoke<StoredMeeting | null>("meeting_get", { id }),
  meetingCreate: (prospectId: string, kind: "R1" | "R2", scheduledAt: string) =>
    invoke<StoredMeeting>("meeting_create", { prospectId, kind, scheduledAt }),
  meetingUpdate: (id: string, patch: MeetingPatch) => invoke<StoredMeeting>("meeting_update", { id, patch }),
  meetingSetConsent: (id: string, given: boolean) => invoke<StoredMeeting>("meeting_set_consent", { id, given }),
  meetingDelete: (id: string) => invoke<void>("meeting_delete", { id }),
  meetingPurgeContent: (id: string) => invoke<void>("meeting_purge_content", { id }),

  segmentList: (meetingId: string) => invoke<Segment[]>("segment_list", { meetingId }),
  segmentAdd: (meetingId: string, speaker: string, text: string, startMs: number) =>
    invoke<Segment>("segment_add", { meetingId, speaker, text, startMs }),
  segmentUpdate: (id: string, patch: { speaker?: string; text?: string }) =>
    invoke<Segment>("segment_update", { id, speaker: patch.speaker ?? null, text: patch.text ?? null }),
  segmentDelete: (id: string) => invoke<void>("segment_delete", { id }),

  audioDevices: () => invoke<string[]>("audio_devices"),
  audioStatus: () => invoke<AudioStatus>("audio_status"),
  audioStart: (meetingId: string) => invoke<AudioStatus>("audio_start", { meetingId }),
  audioPause: () => invoke<AudioStatus>("audio_pause"),
  audioResume: () => invoke<AudioStatus>("audio_resume"),
  audioStop: (discard = false) => invoke<AudioStatus>("audio_stop", { discard }),
  audioSetSpeaker: (speaker: string) => invoke<void>("audio_set_speaker", { speaker }),
  whisperCheck: (path: string) => invoke<number>("whisper_check", { path }),

  ollamaStatus: () => invoke<OllamaStatus>("ollama_status"),
  ollamaChat: (messages: { role: string; content: string }[], format?: unknown) =>
    invoke<{ content: string; latencyMs: number; model: string }>("ollama_chat", { messages, format: format ?? null }),

  secretSetApiKey: (provider: string, key: string) => invoke<void>("secret_set_api_key", { provider, key }),
  secretHasApiKey: (provider: string) => invoke<boolean>("secret_has_api_key", { provider }),
  secretDeleteApiKey: (provider: string) => invoke<void>("secret_delete_api_key", { provider }),

  cloudAnalyze: (request: { meetingId: string | null; purpose: string; payload: string; previewSha256: string; confirmed: boolean }) =>
    invoke<{ transferId: string; content: string; provider: string; model: string }>("cloud_analyze", { request }),
  cloudTransfers: () => invoke<CloudTransfer[]>("cloud_transfers"),
  cloudResults: (meetingId: string) => invoke<CloudResult[]>("cloud_results", { meetingId }),

  exportSave: (path: string, content: { text?: string; bytes?: Uint8Array }) =>
    invoke<void>("export_save", { path, text: content.text ?? null, bytes: content.bytes ? Array.from(content.bytes) : null }),
  retentionApply: () => invoke<number>("retention_apply"),
};

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
