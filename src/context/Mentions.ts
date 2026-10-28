// @dosya bağlamı: seçili kod, dosya seçici, aktif editör.

import * as vscode from 'vscode';
import * as path from 'path';
import { Attachment } from '../cli/protocol';

export function relPath(fsPath: string, root: string): string {
  const rel = path.relative(root, fsPath);
  const p = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : fsPath;
  return p.replace(/\\/g, '/');
}

/** Seçimi `@yol#L10-20` (tek satırda `@yol#L10`) olarak döner. */
export function selectionMention(editor: vscode.TextEditor, root: string): string {
  const p = relPath(editor.document.uri.fsPath, root);
  const sel = editor.selection;
  if (sel.isEmpty) {
    return `@${p}`;
  }
  const start = sel.start.line + 1;
  // Seçim satır başında bitiyorsa o satır dahil değildir.
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return start === end ? `@${p}#L${start}` : `@${p}#L${start}-${end}`;
}

export async function pickFileMention(root: string): Promise<string | undefined> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/*'),
    '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/dist/**,**/out/**}',
    5000,
  );
  const items = files.map((f) => relPath(f.fsPath, root)).sort();
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Sohbete eklenecek dosya' });
  return pick ? `@${pick}` : undefined;
}

export function activeFileAttachment(root: string): Attachment | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file') {
    return undefined;
  }
  return { path: relPath(ed.document.uri.fsPath, root) };
}
