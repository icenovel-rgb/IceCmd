import { Channel, invoke } from "@tauri-apps/api/core";
import type { FsEntry, PathInfo, SessionKind } from "../types";

/**
 * Tauri delivers channel payloads as an ArrayBuffer, but small ones travel a
 * different code path than large ones, so accept every shape it might hand us.
 */
type RawChunk = ArrayBuffer | Uint8Array | number[] | string;

function toBytes(chunk: RawChunk): Uint8Array | string {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (Array.isArray(chunk)) return new Uint8Array(chunk);
  return chunk;
}

export interface CreateSessionOptions {
  sessionId: string;
  cwd: string;
  kind: SessionKind;
  cols: number;
  rows: number;
}

/**
 * Spawns a PTY and streams its output. The caller must already be forwarding
 * terminal input: ConPTY opens with a cursor-position query and produces nothing
 * until the terminal answers it.
 */
export async function createSession(
  options: CreateSessionOptions,
  onData: (chunk: Uint8Array | string) => void,
): Promise<void> {
  const channel = new Channel<RawChunk>();
  channel.onmessage = (chunk) => onData(toBytes(chunk));
  await invoke("create_session", { args: options, onData: channel });
}

export const writeSession = (sessionId: string, data: string) =>
  invoke<void>("write_session", { sessionId, data });

export const resizeSession = (sessionId: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { sessionId, cols, rows });

export const ackOutput = (sessionId: string, bytes: number) =>
  invoke<void>("ack_output", { sessionId, bytes });

export const killSession = (sessionId: string) =>
  invoke<void>("kill_session", { sessionId });

export const sessionAlive = (sessionId: string) =>
  invoke<boolean>("session_alive", { sessionId });

export const readDir = (path: string) => invoke<FsEntry[]>("read_dir", { path });

export const pathInfo = (path: string) => invoke<PathInfo>("path_info", { path });

export const loadState = () => invoke<string | null>("load_state");

export const saveState = (json: string) => invoke<void>("save_state", { json });

/** Sends a line to the `tauri dev` console; useful when the UI cannot be watched. */
export const logLine = (message: string) =>
  invoke<void>("log_line", { message }).catch(() => {});

export const openExternal = (url: string) => invoke<void>("open_external", { url });
