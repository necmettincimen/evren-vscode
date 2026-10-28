// Extension Host içinde çalışır: sohbeti açar, gerçek bir istek gönderir, diff'i düzenleyip onaylar.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatViewProvider } from '../../chat/ChatViewProvider';
import type { EvrenEvent } from '../../cli/protocol';

const MARK = '<!-- elle düzenlendi -->';

function waitFor<T>(fn: () => T | undefined, ms: number, what: string): Promise<T> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`zaman aşımı: ${what}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function diffTab(): vscode.TabInputTextDiff | undefined {
  for (const t of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    if (t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === 'evren-orig') {
      return t.input;
    }
  }
  return undefined;
}

export async function run(): Promise<void> {
  const ws = process.env.EVREN_E2E_WS!;
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'evren-vscode')!;
  const { chat } = (await ext.activate()) as { chat: ChatViewProvider };
  await vscode.commands.executeCommand('evren.openChat');
  await chat.start();
  const proc = await waitFor(() => (chat.process?.ready ? chat.process : undefined), 60_000, 'ready');
  console.log(`[e2e] hazır: evren ${proc.ready!.version}, model ${proc.ready!.model}`);

  const models = await proc.request({ type: 'list_models' }, 'models');
  assert.ok(models.models.length > 0, 'model listesi boş');

  const seen: string[] = [];
  let edited = false;
  const turnEnd = new Promise<Extract<EvrenEvent, { type: 'turn_end' }>>((resolve) => {
    chat.events.event(async (ev) => {
      seen.push(ev.type);
      if (ev.type === 'tool_call') console.log(`[e2e] tool_call ${ev.name}`);
      if (ev.type === 'approval_request') {
        console.log(`[e2e] approval_request ${ev.kind}: ${ev.title}`);
        if (ev.kind === 'edit') {
          const input = await waitFor(diffTab, 10_000, 'diff sekmesi');
          const doc = await vscode.workspace.openTextDocument(input.modified);
          const we = new vscode.WorkspaceEdit();
          const end = doc.lineAt(doc.lineCount - 1).range.end;
          we.insert(doc.uri, end, (doc.getText().endsWith('\n') ? '' : '\n') + MARK + '\n');
          await vscode.workspace.applyEdit(we);
          edited = true;
        }
        await chat.answerApproval(ev.request_id, 'allow');
      }
      if (ev.type === 'ask_user') {
        proc.send({ type: 'ask_user_response', request_id: ev.request_id, answer: ev.options?.[0] ?? 'evet' });
      }
      if (ev.type === 'turn_end') resolve(ev);
    });
  });

  await chat.sendPrompt("README.md dosyasının en sonuna 'Merhaba Evren' satırını ekle. edit_file kullan, başka hiçbir şey yapma.");
  const end = await Promise.race([
    turnEnd,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tur 5 dk içinde bitmedi')), 300_000)),
  ]);
  console.log(`[e2e] olaylar: ${[...new Set(seen)].join(', ')}`);
  console.log(`[e2e] turn_end exit=${end.exit_code} changed=${JSON.stringify(end.changed_files)}`);

  const readme = fs.readFileSync(path.join(ws, 'README.md'), 'utf8');
  console.log(`[e2e] README:\n${readme}`);
  assert.equal(end.exit_code, 0, 'tur başarısız');
  assert.ok(seen.includes('turn_start') && seen.includes('usage'), 'turn_start/usage eksik');
  assert.ok(seen.includes('file_change_proposed'), 'file_change_proposed gelmedi');
  assert.ok(edited, 'diff düzenlenmedi');
  assert.ok(readme.includes('Merhaba Evren'), 'satır eklenmedi');
  assert.ok(readme.includes(MARK), 'edited_content diske yazılmadı');
  assert.equal(diffTab(), undefined, 'diff sekmesi kapanmadı');

  const sessions = await proc.request({ type: 'list_sessions' }, 'sessions');
  console.log(`[e2e] oturum sayısı: ${sessions.items.length}`);
  if (sessions.items.length) {
    const loaded = await proc.request({ type: 'resume', session_id: sessions.items[0].session_id }, 'session_loaded');
    assert.ok(loaded.messages.length > 0, 'resume boş döndü');
  }
  await proc.stop();
}
