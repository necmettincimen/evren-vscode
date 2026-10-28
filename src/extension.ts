import * as vscode from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { DiffManager } from './diff/DiffManager';

export function activate(ctx: vscode.ExtensionContext): { chat: ChatViewProvider } {
  const log = vscode.window.createOutputChannel('Evren');
  const diff = new DiffManager(path.join(ctx.globalStorageUri.fsPath, 'proposals'));
  const chat = new ChatViewProvider(ctx, log, diff);

  ctx.subscriptions.push(
    log,
    diff,
    chat,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('evren.openChat', () => chat.reveal()),
    vscode.commands.registerCommand('evren.newSession', () => chat.newSession()),
    vscode.commands.registerCommand('evren.resumeSession', () => chat.resumeSession()),
    vscode.commands.registerCommand('evren.selectModel', () => chat.selectModel()),
    vscode.commands.registerCommand('evren.selectMode', () => chat.selectMode()),
    vscode.commands.registerCommand('evren.cancel', () => chat.cancel()),
    vscode.commands.registerCommand('evren.showLogs', () => log.show(true)),
    vscode.commands.registerCommand('evren.restart', () => chat.restart()),
    vscode.commands.registerCommand('evren.acceptChange', () => chat.answerLatestDiff('allow')),
    vscode.commands.registerCommand('evren.rejectChange', () => chat.answerLatestDiff('deny')),
    vscode.commands.registerTextEditorCommand('evren.addSelection', (editor) => chat.addSelection(editor)),
  );
  return { chat };
}

export function deactivate(): void {
  // Süreç ChatViewProvider.dispose içinde kapatılır.
}
