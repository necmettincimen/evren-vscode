// Webview → eklenti mesajlarının tip doğrulaması (vscode'a bağımlı değil).

import { Decision, Mode } from '../cli/protocol';

export const MODES: Mode[] = ['normal', 'plan', 'ask'];
const DECISIONS: Decision[] = ['allow', 'deny', 'always'];

/** Webview → eklenti mesajları; her alan tip doğrulamasından geçer. */
export type InMsg =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'approval'; request_id: string; decision: Decision }
  | { type: 'askAnswer'; request_id: string; answer: string }
  | { type: 'showDiff'; request_id: string }
  | { type: 'setMode'; mode: Mode }
  | { type: 'pickModel' }
  | { type: 'history' }
  | { type: 'newSession' }
  | { type: 'restart' }
  | { type: 'pickFile' }
  | { type: 'showLogs' };

function str(v: unknown, max = 200_000): v is string {
  return typeof v === 'string' && v.length <= max;
}

export function parseInMsg(raw: unknown): InMsg | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready': case 'cancel': case 'pickModel': case 'history':
    case 'newSession': case 'restart': case 'pickFile': case 'showLogs':
      return { type: m.type };
    case 'send':
      return str(m.text) ? { type: 'send', text: m.text } : undefined;
    case 'approval':
      return str(m.request_id, 200) && DECISIONS.includes(m.decision as Decision)
        ? { type: 'approval', request_id: m.request_id, decision: m.decision as Decision } : undefined;
    case 'askAnswer':
      return str(m.request_id, 200) && str(m.answer) ? { type: 'askAnswer', request_id: m.request_id, answer: m.answer } : undefined;
    case 'showDiff':
      return str(m.request_id, 200) ? { type: 'showDiff', request_id: m.request_id } : undefined;
    case 'setMode':
      return MODES.includes(m.mode as Mode) ? { type: 'setMode', mode: m.mode as Mode } : undefined;
    default:
      return undefined;
  }
}
