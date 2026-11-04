// Kenar çubuğu sohbet görünümü: sekmeler (her biri ayrı CLI süreci), geçmiş ve webview köprüsü.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { EvrenProcess } from '../cli/EvrenProcess';
import { Decision, EvrenEvent, Mode } from '../cli/protocol';
import { InMsg, MODES, parseInMsg } from './messages';
import { ChatSession, SessionHost } from './ChatSession';
import { HistoryItem, listHistory } from './history';
import { DiffManager } from '../diff/DiffManager';
import { activeFileAttachment, pickFileMention, selectionMention } from '../context/Mentions';
import { Attachment } from '../cli/protocol';

/** Değişince CLI sürecinin yeniden başlatılması gereken ayarlar (buildLaunch girdileri). */
const LAUNCH_SETTINGS = ['cliPath', 'pythonPath', 'cliRepo', 'model', 'autoApprove', 'allowedTools', 'extraEnv'];

/** Aynı anda açık sekme (= CLI süreci) üst sınırı. */
export const MAX_TABS = 6;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, SessionHost {
  static readonly viewId = 'evren.chat';

  private view?: vscode.WebviewView;
  private webviewReady = false;
  private outbox: unknown[] = [];
  private sessions = new Map<string, ChatSession>();
  private activeId = '';
  private seq = 0;
  private root = '';
  private history: HistoryItem[] = [];
  private statusItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  /** CLI olayları (testler ve ileride başka görünümler için); tüm sekmeleri kapsar. */
  readonly events = new vscode.EventEmitter<EvrenEvent>();

  constructor(
    private ctx: vscode.ExtensionContext,
    readonly log: vscode.OutputChannel,
    readonly diff: DiffManager,
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'evren.openChat';
    this.statusItem.show();
    this.updateStatusBar();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (LAUNCH_SETTINGS.some((k) => e.affectsConfiguration(`evren.${k}`))) {
          this.sessions.forEach((s) => s.restartForSettings());
        }
      }),
    );
  }

  // --- SessionHost ---

  post(sid: string, msg: Record<string, unknown>): void {
    this.postRaw({ ...msg, sid });
  }

  changed(): void {
    this.postRaw({ type: 'tabs', tabs: [...this.sessions.values()].map((s) => s.info), active: this.activeId });
    this.updateStatusBar();
  }

  fire(ev: EvrenEvent): void {
    this.events.fire(ev);
  }

  // --- Webview ---

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.disposables.push(
      view.webview.onDidReceiveMessage((raw) => {
        const msg = parseInMsg(raw);
        if (!msg) {
          this.log.appendLine(`[webview] geçersiz mesaj yok sayıldı: ${JSON.stringify(raw).slice(0, 200)}`);
          return;
        }
        void this.onWebviewMessage(msg).catch((err) => this.reportError(err));
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.webviewReady = false;
      }),
    );
  }

  private postRaw(msg: unknown): void {
    if (this.view && this.webviewReady) {
      void this.view.webview.postMessage(msg);
    } else {
      this.outbox.push(msg);
    }
  }

  private updateStatusBar(): void {
    const s = this.active;
    const busyCount = [...this.sessions.values()].filter((x) => x.busy).length;
    const icon = s?.state === 'ready' ? (busyCount ? '$(sync~spin)' : '$(comment-discussion)') : '$(warning)';
    const tok = s?.tokens ? ` · ${formatTokens(s.tokens)} tok` : '';
    const more = busyCount > 1 ? ` · ${busyCount} oturum çalışıyor` : '';
    this.statusItem.text = `${icon} Evren ${s?.model || ''} · ${s?.mode ?? 'normal'}${tok}${more}`.replace(/\s+·/, ' ·');
    this.statusItem.tooltip = s?.state === 'ready' ? `evren ${s.version} — ${this.root}` : `Evren: ${s?.state ?? 'stopped'}`;
  }

  private async onWebviewMessage(msg: InMsg): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        this.postRaw({ type: 'tabs', tabs: [...this.sessions.values()].map((s) => s.info), active: this.activeId });
        for (const s of this.sessions.values()) {
          s.postStatus();
        }
        for (const m of this.outbox.splice(0)) {
          void this.view?.webview.postMessage(m);
        }
        if (!this.sessions.size) {
          await this.openTab();
        }
        return;
      case 'send':
        return this.sendPrompt(msg.sid, msg.text);
      case 'cancel':
        return this.sessions.get(msg.sid)?.cancel();
      case 'approval':
        return this.sessions.get(msg.sid)?.answerApproval(msg.request_id, msg.decision);
      case 'askAnswer':
        return this.sessions.get(msg.sid)?.answerAsk(msg.request_id, msg.answer);
      case 'showDiff':
        return this.sessions.get(msg.sid)?.showDiff(msg.request_id);
      case 'setMode':
        return this.sessions.get(msg.sid)?.setMode(msg.mode);
      case 'pickModel':
        return this.sessions.get(msg.sid)?.selectModel();
      case 'restart':
        return this.sessions.get(msg.sid)?.restart();
      case 'selectTab':
        return this.selectTab(msg.sid);
      case 'closeTab':
        return this.closeTab(msg.sid);
      case 'newTab':
        await this.openTab();
        return;
      case 'history':
        return this.showHistory();
      case 'resumeHistory':
        return this.resumeFromHistory(msg.session_id);
      case 'pickFile': {
        const m = await pickFileMention(this.root);
        if (m) {
          this.postRaw({ type: 'insert', text: m + ' ' });
        }
        return;
      }
      case 'showLogs':
        this.log.show(true);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage('Evren: panoya kopyalandı', 1500);
        return;
    }
  }

  // --- Sekmeler ---

  get active(): ChatSession | undefined {
    return this.sessions.get(this.activeId);
  }

  /** Etkin sekmenin CLI süreci (testler ve ajanlar görünümü için). */
  get process(): EvrenProcess | undefined {
    return this.active?.proc;
  }

  /** Bu pencerenin tüm stdio süreçlerinin pid'leri. */
  pids(): number[] {
    return [...this.sessions.values()].map((s) => s.proc?.pid).filter((p): p is number => p !== undefined);
  }

  private async pickRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      return folders[0]?.uri.fsPath;
    }
    const saved = this.ctx.workspaceState.get<string>('evren.root');
    if (saved && folders.some((f) => f.uri.fsPath === saved)) {
      return saved;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active && vscode.workspace.getWorkspaceFolder(active);
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: f === activeFolder })),
      { placeHolder: 'Evren hangi çalışma alanı klasöründe çalışsın?' },
    );
    const root = pick?.description ?? activeFolder?.uri.fsPath ?? folders[0].uri.fsPath;
    await this.ctx.workspaceState.update('evren.root', root);
    return root;
  }

  /** Yeni sekme açar, CLI sürecini başlatır ve etkin yapar. */
  async openTab(): Promise<ChatSession | undefined> {
    if (this.sessions.size >= MAX_TABS) {
      void vscode.window.showInformationMessage(`En fazla ${MAX_TABS} sohbet sekmesi açık olabilir; birini kapatın.`);
      return undefined;
    }
    if (!this.root) {
      this.root = (await this.pickRoot()) ?? '';
    }
    if (!this.root) {
      void vscode.window.showWarningMessage('Evren için bir klasör açın.');
      return undefined;
    }
    const mode = vscode.workspace.getConfiguration('evren').get<Mode>('defaultMode', 'normal');
    const session = new ChatSession(`t${++this.seq}`, this, this.root, MODES.includes(mode) ? mode : 'normal');
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    this.changed();
    await session.start();
    return session;
  }

  private selectTab(sid: string): void {
    if (this.sessions.has(sid) && sid !== this.activeId) {
      this.activeId = sid;
      this.changed();
    }
  }

  private async closeTab(sid: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (!s) {
      return;
    }
    if (s.busy) {
      const ok = await vscode.window.showWarningMessage(
        `"${s.info.title}" çalışıyor; kapatılırsa tur iptal edilir.`, { modal: true }, 'Kapat',
      );
      if (ok !== 'Kapat') {
        return;
      }
    }
    const order = [...this.sessions.keys()];
    const idx = order.indexOf(sid);
    this.sessions.delete(sid);
    this.postRaw({ type: 'tabClosed', sid });
    if (this.activeId === sid) {
      this.activeId = order[idx + 1] ?? order[idx - 1] ?? '';
    }
    await s.dispose();
    if (this.sessions.size) {
      this.changed();
    } else {
      await this.openTab();
    }
  }

  // --- Geçmiş ---

  async showHistory(): Promise<void> {
    if (!this.root) {
      this.root = (await this.pickRoot()) ?? '';
    }
    this.history = this.root ? await listHistory(this.root) : [];
    const open = new Set([...this.sessions.values()].map((s) => s.cliSessionId).filter(Boolean));
    this.postRaw({
      type: 'history',
      items: this.history.map((h) => ({ ...h, open: open.has(h.session_id) })),
    });
  }

  /** Komut paleti / başlık düğmesi: paneli açıp geçmiş listesini gösterir. */
  async resumeSession(): Promise<void> {
    await this.reveal();
    await this.showHistory();
  }

  private async resumeFromHistory(sessionId: string): Promise<void> {
    const open = [...this.sessions.values()].find((s) => s.cliSessionId === sessionId);
    if (open) {
      this.selectTab(open.id);
      return;
    }
    const item = this.history.find((h) => h.session_id === sessionId);
    let target = this.active;
    if (!target || !target.pristine) {
      target = await this.openTab();
    }
    if (!target) {
      return;
    }
    await target.start();
    await target.resume(sessionId, item?.title ?? '');
    this.activeId = target.id;
    this.changed();
  }

  // --- Eylemler ---

  private async sendPrompt(sid: string, text: string): Promise<void> {
    const s = this.sessions.get(sid);
    if (!s) {
      return;
    }
    const attachments: Attachment[] = [];
    if (vscode.workspace.getConfiguration('evren').get<boolean>('autoAttachActiveFile', false)) {
      const a = activeFileAttachment(this.root);
      if (a) {
        attachments.push(a);
      }
    }
    s.sendPrompt(text, attachments);
  }

  async start(): Promise<void> {
    if (!this.sessions.size) {
      await this.openTab();
    } else {
      await this.active?.start();
    }
  }

  async restart(): Promise<void> {
    await this.active?.restart();
  }

  cancel(): void {
    this.active?.cancel();
  }

  async newSession(): Promise<void> {
    await this.reveal();
    await this.openTab();
  }

  /** Editör başlığındaki Kabul/Reddet düğmeleri için: son açılan diff'e yanıt verir. */
  async answerLatestDiff(decision: Decision): Promise<void> {
    const key = this.diff.latest();
    const colon = key?.indexOf(':') ?? -1;
    if (key && colon > 0) {
      await this.sessions.get(key.slice(0, colon))?.answerApproval(key.slice(colon + 1), decision);
    }
  }

  async selectMode(): Promise<void> {
    const s = this.active;
    if (!s) {
      return;
    }
    const pick = await vscode.window.showQuickPick(MODES, { placeHolder: `Kip (şu an ${s.mode})` });
    if (pick) {
      await s.setMode(pick as Mode);
    }
  }

  async selectModel(): Promise<void> {
    await this.active?.selectModel();
  }

  addSelection(editor: vscode.TextEditor): void {
    this.postRaw({ type: 'insert', text: selectionMention(editor, this.root || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') + ' ' });
    void this.reveal();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  private reportError(err: unknown): void {
    const e = err as Error;
    this.log.appendLine(`[evren] ${e.message ?? String(err)}`);
    void vscode.window.showWarningMessage(`Evren: ${e.message ?? String(err)}`);
  }

  // --- HTML ---

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Evren</title>
</head>
<body>
<nav id="tabs">
  <div id="tablist" role="tablist"></div>
  <button id="newtab" class="icon" title="Yeni sohbet sekmesi (paralel oturum)" aria-label="Yeni sohbet sekmesi">+</button>
  <button id="histbtn" class="icon" title="Geçmiş oturumlar" aria-label="Geçmiş oturumlar">&#x1F552;</button>
</nav>
<div id="banner" hidden></div>
<section id="todos" hidden></section>
<div id="logs"></div>
<section id="history" hidden>
  <div class="hist-head">
    <input id="histfilter" type="search" placeholder="Oturumlarda ara…" aria-label="Oturumlarda ara">
    <button id="histclose" class="icon" title="Kapat (Esc)" aria-label="Kapat">&times;</button>
  </div>
  <div id="histlist"></div>
</section>
<footer>
  <div id="working" hidden>
    <span class="spinner" aria-hidden="true"></span>
    <span id="stage">Düşünüyor</span>
    <span id="elapsed"></span>
    <span class="spacer"></span>
    <span class="hint">Esc ile durdur</span>
  </div>
  <details id="promptkit" class="promptkit" open hidden>
    <summary>Prompt yardımcısı <span class="sub">rol · hedef · çıktı (isteğe bağlı)</span></summary>
    <label>Rol <textarea id="kit-role" rows="1" placeholder="Örn. Kıdemli bir TypeScript geliştiricisi gibi davran"></textarea></label>
    <label>Hedef <textarea id="kit-goal" rows="2" placeholder="Örn. Giriş ekranındaki oturum yenileme hatasını bul ve düzelt"></textarea></label>
    <label>Çıktı <textarea id="kit-out" rows="1" placeholder="Örn. Önce kısa plan, sonra yalnız değişen dosyalar; Türkçe, kısa"></textarea></label>
    <div class="hint">Gönderince bu alanlar aşağıdaki mesajla tek prompt'ta birleşir.</div>
  </details>
  <div class="composer">
    <textarea id="input" rows="3" placeholder="Evren'e yaz… (@ dosya ekler, Enter gönderir, Shift+Enter yeni satır)"></textarea>
    <div class="toolbar">
      <select id="mode" class="chip" title="Kip (Shift+Tab ile değiştir)">
        <option value="normal">Normal</option><option value="plan">Plan</option><option value="ask">Sor</option>
      </select>
      <button id="model" class="chip" title="Model seç">model</button>
      <button id="attach" class="icon" title="Dosya ekle (@)">@</button>
      <span class="spacer"></span>
      <span id="status"></span>
      <button id="stop" class="round stop" hidden title="Durdur (Esc)" aria-label="Durdur"></button>
      <button id="send" class="round send" title="Gönder (Enter)" aria-label="Gönder"></button>
    </div>
  </div>
</footer>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const s of this.sessions.values()) {
      void s.dispose();
    }
    this.sessions.clear();
    this.statusItem.dispose();
    this.events.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
