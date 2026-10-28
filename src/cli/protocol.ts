// `evren --stdio` v1 protokolünün TypeScript karşılığı (evren-cli/docs/stdio-protocol.md).

export const PROTOCOL_VERSION = 1;
export const MIN_CLI_VERSION = '3.10.0';

export type Mode = 'normal' | 'plan' | 'ask';
export type Decision = 'allow' | 'deny' | 'always';
export type ApprovalKind = 'edit' | 'command' | 'ssh' | 'other';

export interface Attachment {
  path: string;
  range?: { start: number; end: number };
}

// --- Komutlar (eklenti → CLI) ---

export type Command =
  | { type: 'prompt'; text: string; mode?: Mode; attachments?: Attachment[] }
  | { type: 'cancel' }
  | { type: 'approval_response'; request_id: string; decision: Decision; edited_content?: string }
  | { type: 'ask_user_response'; request_id: string; answer: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_mode'; mode: Mode }
  | { type: 'list_sessions'; limit?: number }
  | { type: 'resume'; session_id: string }
  | { type: 'new_session' }
  | { type: 'list_models' }
  | { type: 'quota' }
  | { type: 'slash'; command: string; args?: string };

export type CommandType = Command['type'];

// --- Olaylar (CLI → eklenti) ---

interface Envelope {
  v: number;
  id?: string;
  reply_to?: string;
}

export interface SessionInfo {
  session_id: string;
  title?: string;
  model?: string;
  mode?: string;
}

export interface TodoItem {
  content: string;
  status: string;
}

export type EvrenEvent = Envelope &
  (
    | { type: 'ready'; version: string; model: string; workspace: string; protocol?: number }
    | { type: 'turn_start' }
    | { type: 'assistant_delta'; text: string }
    | { type: 'reasoning_delta'; text: string }
    | { type: 'tool_call'; call_id: string; name: string; args: unknown }
    | { type: 'tool_result'; call_id: string; name?: string; ok: boolean; summary: string; output_truncated: boolean }
    | { type: 'file_change_proposed'; request_id: string; path: string; old_content: string; new_content: string }
    | { type: 'approval_request'; request_id: string; kind: ApprovalKind; title: string; detail: string }
    | { type: 'ask_user'; request_id: string; question: string; options?: string[] }
    | { type: 'todos'; items: TodoItem[] }
    | { type: 'usage'; prompt_tokens: number; completion_tokens: number; quota_left?: unknown }
    | { type: 'turn_end'; result: string; changed_files: string[]; exit_code: number }
    | { type: 'error'; message: string; code: string }
    | { type: 'model_changed'; model: string }
    | { type: 'mode_changed'; mode: Mode }
    | { type: 'sessions'; items: SessionInfo[] }
    | { type: 'session_loaded'; session_id: string | null; messages: { role: string; text: string }[] }
    | { type: 'models'; models: string[]; current: string }
    | { type: 'quota'; quota: unknown }
  );

export type EventType = EvrenEvent['type'];
export type EventOf<T extends EventType> = Extract<EvrenEvent, { type: T }>;

const KNOWN_EVENTS: ReadonlySet<string> = new Set<EventType>([
  'ready', 'turn_start', 'assistant_delta', 'reasoning_delta', 'tool_call', 'tool_result',
  'file_change_proposed', 'approval_request', 'ask_user', 'todos', 'usage', 'turn_end', 'error',
  'model_changed', 'mode_changed', 'sessions', 'session_loaded', 'models', 'quota',
]);

export function encodeCommand(cmd: Command, id?: string): string {
  const msg: Record<string, unknown> = { v: PROTOCOL_VERSION, ...cmd };
  if (id !== undefined) {
    msg.id = id;
  }
  return JSON.stringify(msg) + '\n';
}

/** Tek bir satırı çözer. Boş satır, bozuk JSON ya da tanınmayan olay için `undefined`. */
export function parseEvent(line: string): EvrenEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== 'string' || !KNOWN_EVENTS.has(rec.type)) {
    return undefined;
  }
  if (rec.v !== PROTOCOL_VERSION) {
    return undefined;
  }
  return rec as unknown as EvrenEvent;
}

/** NDJSON akışını satırlara böler; parçalı gelen veriyi tamponlar. */
export class LineSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  }

  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest ? [rest] : [];
  }
}

/** "3.10.0" >= "3.9.12" gibi nokta ayrımlı sürüm karşılaştırması. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const b = min.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return true;
}
