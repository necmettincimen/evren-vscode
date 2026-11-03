// Webview → eklenti mesajlarının tip doğrulaması (vscode'a bağımlı değil).

import { Decision, Mode } from '../cli/protocol';

export const MODES: Mode[] = ['normal', 'plan', 'ask'];
const DECISIONS: Decision[] = ['allow', 'deny', 'always'];

/** Webview → eklenti mesajları; her alan tip doğrulamasından geçer. `sid` sekme kimliğidir. */
export type InMsg =
  | { type: 'ready' }
  | { type: 'send'; sid: string; text: string }
  | { type: 'cancel'; sid: string }
  | { type: 'approval'; sid: string; request_id: string; decision: Decision }
  | { type: 'askAnswer'; sid: string; request_id: string; answer: string }
  | { type: 'showDiff'; sid: string; request_id: string }
  | { type: 'setMode'; sid: string; mode: Mode }
  | { type: 'pickModel'; sid: string }
  | { type: 'restart'; sid: string }
  | { type: 'selectTab'; sid: string }
  | { type: 'closeTab'; sid: string }
  | { type: 'newTab' }
  | { type: 'history' }
  | { type: 'resumeHistory'; session_id: string }
  | { type: 'pickFile' }
  | { type: 'showLogs' }
  | { type: 'copy'; text: string };

function str(v: unknown, max = 200_000): v is string {
  return typeof v === 'string' && v.length <= max;
}

export function parseInMsg(raw: unknown): InMsg | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready': case 'newTab': case 'history': case 'pickFile': case 'showLogs':
      return { type: m.type };
    case 'cancel': case 'pickModel': case 'restart': case 'selectTab': case 'closeTab':
      return str(m.sid, 64) ? { type: m.type, sid: m.sid } : undefined;
    case 'send':
      return str(m.sid, 64) && str(m.text) ? { type: 'send', sid: m.sid, text: m.text } : undefined;
    case 'approval':
      return str(m.sid, 64) && str(m.request_id, 200) && DECISIONS.includes(m.decision as Decision)
        ? { type: 'approval', sid: m.sid, request_id: m.request_id, decision: m.decision as Decision } : undefined;
    case 'askAnswer':
      return str(m.sid, 64) && str(m.request_id, 200) && str(m.answer)
        ? { type: 'askAnswer', sid: m.sid, request_id: m.request_id, answer: m.answer } : undefined;
    case 'showDiff':
      return str(m.sid, 64) && str(m.request_id, 200) ? { type: 'showDiff', sid: m.sid, request_id: m.request_id } : undefined;
    case 'setMode':
      return str(m.sid, 64) && MODES.includes(m.mode as Mode) ? { type: 'setMode', sid: m.sid, mode: m.mode as Mode } : undefined;
    case 'resumeHistory':
      return str(m.session_id, 200) ? { type: 'resumeHistory', session_id: m.session_id } : undefined;
    case 'copy':
      return str(m.text) ? { type: 'copy', text: m.text } : undefined;
    default:
      return undefined;
  }
}
