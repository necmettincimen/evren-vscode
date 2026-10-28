// Kenar çubuğu sohbet görünümü ve CLI süreci arasındaki köprü.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { EvrenProcess, ProtocolError, buildLaunch } from '../cli/EvrenProcess';
import { Attachment, Decision, EvrenEvent, Mode } from '../cli/protocol';
import { InMsg, MODES, parseInMsg } from './messages';
import { DiffManager } from '../diff/DiffManager';
import { activeFileAttachment, pickFileMention, selectionMention } from '../context/Mentions';

type State = 'stopped' | 'starting' | 'ready' | 'crashed' | 'error';

/** Değişince CLI sürecinin yeniden başlatılması gereken ayarlar (buildLaunch girdileri). */
const LAUNCH_SETTINGS = ['cliPath', 'pythonPath', 'cliRepo', 'model', 'autoApprove', 'allowedTools', 'extraEnv'];

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'evren.chat';

  private view?: vscode.WebviewView;
  private webviewReady = false;
  private outbox: unknown[] = [];
  private proc?: EvrenProcess;
  private state: State = 'stopped';
  private busy = false;
  private restartAfterTurn = false;
  private model = '';
  private mode: Mode = 'normal';
  private version = '';
  private tokens = 0;
  private promptId?: string;
  private root = '';
  private pendingApprovals = new Map<string, string>(); // request_id → kind
  private pendingAsks = new Set<string>();
  private statusItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  /** CLI olayları (testler ve ileride başka görünümler için). */
  readonly events = new vscode.EventEmitter<EvrenEvent>();

  constructor(
    private ctx: vscode.ExtensionContext,
    private log: vscode.OutputChannel,
    private diff: DiffManager,
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'evren.openChat';
    this.statusItem.show();
    this.mode = vscode.workspace.getConfiguration('evren').get<Mode>('defaultMode', 'normal');
    this.updateStatusBar();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!LAUNCH_SETTINGS.some((k) => e.affectsConfiguration(`evren.${k}`)) || !this.proc?.running) {
          return;
        }
        // Başlatma argümanları değişti: süreç yeni ayarla açılır; tur sürüyorsa bitince.
        if (this.busy) {
          this.restartAfterTurn = true;
          void vscode.window.showInformationMessage('Evren ayarı değişti; CLI tur bitince yeniden başlatılacak.');
        } else {
          void this.restart();
        }
      }),
    );
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

  private post(msg: unknown): void {
    if (this.view && this.webviewReady) {
      void this.view.webview.postMessage(msg);
    } else {
      this.outbox.push(msg);
    }
  }

  private postStatus(message?: string): void {
    this.post({
      type: 'status', state: this.state, busy: this.busy, model: this.model, mode: this.mode,
      version: this.version, tokens: this.tokens, message,
    });
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const icon = this.state === 'ready' ? (this.busy ? '$(sync~spin)' : '$(comment-discussion)') : '$(warning)';
    const tok = this.tokens ? ` · ${formatTokens(this.tokens)} tok` : '';
    this.statusItem.text = `${icon} Evren ${this.model || ''} · ${this.mode}${tok}`.replace(/\s+·/, ' ·');
    this.statusItem.tooltip = this.state === 'ready' ? `evren ${this.version} — ${this.root}` : `Evren: ${this.state}`;
  }

  private async onWebviewMessage(msg: InMsg): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        for (const m of this.outbox.splice(0)) {
          void this.view?.webview.postMessage(m);
        }
        this.postStatus();
        if (this.state === 'stopped') {
          await this.start();
        }
        return;
      case 'send':
        return this.sendPrompt(msg.text);
      case 'cancel':
        return this.cancel();
      case 'approval':
        return this.answerApproval(msg.request_id, msg.decision);
      case 'askAnswer':
        if (this.pendingAsks.delete(msg.request_id)) {
          this.proc?.send({ type: 'ask_user_response', request_id: msg.request_id, answer: msg.answer });
        }
        return;
      case 'showDiff':
        return this.diff.show(msg.request_id);
      case 'setMode':
        return this.setMode(msg.mode);
      case 'pickModel':
        return this.selectModel();
      case 'history':
        return this.resumeSession();
      case 'newSession':
        return this.newSession();
      case 'restart':
        return this.restart();
      case 'pickFile': {
        const m = await pickFileMention(this.root);
        if (m) {
          this.post({ type: 'insert', text: m + ' ' });
        }
        return;
      }
      case 'showLogs':
        this.log.show(true);
        return;
    }
  }

  // --- Süreç ---

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

  async start(): Promise<void> {
    if (this.state === 'starting' || this.proc?.running) {
      return;
    }
    const root = await this.pickRoot();
    if (!root) {
      this.state = 'error';
      this.postStatus('Evren için bir klasör açın.');
      return;
    }
    this.root = root;
    const cfg = vscode.workspace.getConfiguration('evren');
    const launch = buildLaunch({
      cliPath: cfg.get<string>('cliPath', 'evren') || 'evren',
      pythonPath: cfg.get<string>('pythonPath', ''),
      cliRepo: cfg.get<string>('cliRepo', ''),
      workspace: root,
      model: cfg.get<string>('model', ''),
      autoApprove: cfg.get<'none' | 'edits' | 'all'>('autoApprove', 'none'),
      allowedTools: cfg.get<string[]>('allowedTools', []),
      extraEnv: cfg.get<Record<string, string>>('extraEnv', {}),
    });
    this.log.appendLine(`[evren] başlatılıyor: ${launch.command} ${launch.args.join(' ')} (cwd ${launch.options.cwd})`);
    const proc = new EvrenProcess(launch, { readyTimeoutMs: 60_000 });
    this.proc = proc;
    proc.on('stderr', (s: string) => this.log.append(s));
    proc.on('protocolError', (line: string) => this.log.appendLine(`[protokol] çözülemeyen satır: ${line.slice(0, 500)}`));
    proc.on('event', (ev: EvrenEvent) => this.onEvent(ev));
    proc.on('exit', (info: { code: number | null; signal: string | null; expected: boolean }) => this.onExit(proc, info));
    this.state = 'starting';
    this.postStatus();
    try {
      const ready = await proc.start();
      this.state = 'ready';
      this.model = ready.model;
      this.version = ready.version;
      this.log.appendLine(`[evren] hazır: ${ready.version}, model ${ready.model}, ${ready.workspace}`);
      const wanted = cfg.get<Mode>('defaultMode', 'normal');
      if (wanted !== 'normal') {
        await this.setMode(wanted);
      }
      this.postStatus();
    } catch (err) {
      this.state = 'error';
      const e = err as ProtocolError;
      this.log.appendLine(`[evren] başlatma hatası (${e.code}): ${e.message}`);
      this.postStatus(e.message);
      await this.explainStartFailure(e);
    }
  }

  private async explainStartFailure(e: ProtocolError): Promise<void> {
    let text: string;
    if (e.code === 'spawn_failed') {
      text = 'evren CLI bulunamadı. `pip install -e <evren-cli>` ile kurun ya da `evren.cliPath` ayarını tam yola çevirin.';
    } else if (e.code === 'old_version') {
      text = `${e.message}. CLI'yı güncelleyin (\`evren update\` ya da \`git pull && pip install -e .\`).`;
    } else {
      text = `Evren başlatılamadı: ${e.message}`;
    }
    const pick = await vscode.window.showErrorMessage(text, 'Ayarlar', 'Logları göster', 'Yeniden dene');
    if (pick === 'Ayarlar') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'evren.');
    } else if (pick === 'Logları göster') {
      this.log.show(true);
    } else if (pick === 'Yeniden dene') {
      await this.restart();
    }
  }

  private onExit(proc: EvrenProcess, info: { code: number | null; signal: string | null; expected: boolean }): void {
    if (proc !== this.proc) {
      return;
    }
    this.log.appendLine(`[evren] süreç çıktı (kod ${info.code ?? info.signal})`);
    this.busy = false;
    this.clearPending();
    if (info.expected || this.state !== 'ready') {
      if (this.state === 'ready') {
        this.state = 'stopped';
      }
      this.postStatus();
      return;
    }
    this.state = 'crashed';
    this.postStatus(`CLI beklenmedik şekilde kapandı (kod ${info.code ?? info.signal}).`);
    void vscode.window.showWarningMessage('Evren CLI kapandı.', 'Yeniden başlat', 'Logları göster').then((pick) => {
      if (pick === 'Yeniden başlat') {
        void this.restart();
      } else if (pick === 'Logları göster') {
        this.log.show(true);
      }
    });
  }

  private clearPending(): void {
    this.pendingApprovals.clear();
    this.pendingAsks.clear();
    void this.diff.closeAll();
    this.post({ type: 'pendingCleared' });
  }

  async restart(): Promise<void> {
    const old = this.proc;
    this.proc = undefined;
    this.clearPending();
    this.busy = false;
    this.state = 'stopped';
    if (old) {
      await old.stop();
    }
    await this.start();
  }

  get process(): EvrenProcess | undefined {
    return this.proc;
  }

  private requireProc(): EvrenProcess | undefined {
    if (this.proc?.running && this.state === 'ready') {
      return this.proc;
    }
    void vscode.window.showWarningMessage('Evren CLI çalışmıyor.', 'Yeniden başlat').then((p) => p && this.restart());
    return undefined;
  }

  // --- Olaylar ---

  private onEvent(ev: EvrenEvent): void {
    switch (ev.type) {
      case 'turn_start':
        this.busy = true;
        this.postStatus();
        break;
      case 'turn_end':
        this.busy = false;
        this.clearPending();
        this.postStatus();
        if (this.restartAfterTurn) {
          this.restartAfterTurn = false;
          void this.restart();
        }
        break;
      case 'file_change_proposed':
        void this.diff.propose(ev.request_id, ev.path, ev.old_content, ev.new_content).catch((err) => this.reportError(err));
        // İçerik büyük olabilir; webview'a yalnız yol gider.
        this.post({ type: 'event', ev: { type: ev.type, request_id: ev.request_id, path: ev.path } });
        this.events.fire(ev);
        return;
      case 'approval_request':
        this.pendingApprovals.set(ev.request_id, ev.kind);
        break;
      case 'ask_user':
        this.pendingAsks.add(ev.request_id);
        break;
      case 'usage':
        this.tokens = (ev.prompt_tokens || 0) + (ev.completion_tokens || 0);
        this.postStatus();
        break;
      case 'model_changed':
        this.model = ev.model;
        this.postStatus();
        break;
      case 'mode_changed':
        this.mode = ev.mode;
        this.postStatus();
        break;
      case 'error':
        this.log.appendLine(`[evren] hata ${ev.code}: ${ev.message}`);
        if (ev.reply_to && ev.reply_to === this.promptId && ev.code !== 'mention') {
          this.busy = false; // tur hiç başlamadı (busy, empty_prompt, internal)
          this.postStatus();
        }
        break;
    }
    this.post({ type: 'event', ev });
    this.events.fire(ev);
  }

  // --- Eylemler ---

  async sendPrompt(text: string): Promise<void> {
    const proc = this.requireProc();
    if (!proc || !text.trim()) {
      return;
    }
    if (this.busy) {
      void vscode.window.showInformationMessage('Evren hâlâ çalışıyor; önce durdurun ya da bitmesini bekleyin.');
      return;
    }
    const attachments: Attachment[] = [];
    if (vscode.workspace.getConfiguration('evren').get<boolean>('autoAttachActiveFile', false)) {
      const a = activeFileAttachment(this.root);
      if (a) {
        attachments.push(a);
      }
    }
    this.post({ type: 'userMessage', text, attachments: attachments.map((a) => a.path) });
    this.busy = true;
    this.postStatus();
    this.promptId = proc.send({ type: 'prompt', text, mode: this.mode, ...(attachments.length ? { attachments } : {}) });
  }

  cancel(): void {
    if (this.proc?.running && this.busy) {
      this.proc.send({ type: 'cancel' });
    }
  }

  async answerApproval(requestId: string, decision: Decision): Promise<void> {
    if (!this.pendingApprovals.has(requestId) || !this.proc?.running) {
      return;
    }
    this.pendingApprovals.delete(requestId);
    let edited: string | undefined;
    if (decision !== 'deny' && this.diff.has(requestId)) {
      edited = await this.diff.editedContent(requestId);
    }
    this.proc.send({
      type: 'approval_response', request_id: requestId, decision,
      ...(edited !== undefined ? { edited_content: edited } : {}),
    });
    this.post({ type: 'approvalDone', request_id: requestId, decision, edited: edited !== undefined });
    await this.diff.close(requestId);
  }

  /** Editör başlığındaki Kabul/Reddet düğmeleri için: son açılan diff'e yanıt verir. */
  async answerLatestDiff(decision: Decision): Promise<void> {
    const id = this.diff.latest();
    if (id) {
      await this.answerApproval(id, decision);
    }
  }

  async setMode(mode: Mode): Promise<void> {
    const proc = this.requireProc();
    if (!proc) {
      return;
    }
    try {
      await proc.request({ type: 'set_mode', mode }, 'mode_changed');
    } catch (err) {
      this.reportError(err);
      this.postStatus();
    }
  }

  async selectMode(): Promise<void> {
    const pick = await vscode.window.showQuickPick(MODES, { placeHolder: `Kip (şu an ${this.mode})` });
    if (pick) {
      await this.setMode(pick as Mode);
    }
  }

  async selectModel(): Promise<void> {
    const proc = this.requireProc();
    if (!proc) {
      return;
    }
    try {
      const res = await proc.request({ type: 'list_models' }, 'models');
      const pick = await vscode.window.showQuickPick(
        res.models.map((m) => ({ label: m, description: m === res.current ? 'şu anki' : undefined })),
        { placeHolder: 'Model seç' },
      );
      if (pick && pick.label !== res.current) {
        await proc.request({ type: 'set_model', model: pick.label }, 'model_changed');
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  async resumeSession(): Promise<void> {
    const proc = this.requireProc();
    if (!proc) {
      return;
    }
    try {
      const res = await proc.request({ type: 'list_sessions', limit: 50 }, 'sessions');
      if (!res.items.length) {
        void vscode.window.showInformationMessage('Bu çalışma alanında kayıtlı oturum yok.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        res.items.map((s) => ({ label: s.title || s.session_id, description: [s.model, s.mode].filter(Boolean).join(' · '), id: s.session_id })),
        { placeHolder: 'Devam ettirilecek oturum' },
      );
      if (pick) {
        await proc.request({ type: 'resume', session_id: pick.id }, 'session_loaded');
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  async newSession(): Promise<void> {
    const proc = this.requireProc();
    if (!proc) {
      return;
    }
    try {
      await proc.request({ type: 'new_session' }, 'session_loaded');
      this.tokens = 0;
      this.postStatus();
    } catch (err) {
      this.reportError(err);
    }
  }

  addSelection(editor: vscode.TextEditor): void {
    this.post({ type: 'insert', text: selectionMention(editor, this.root || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') + ' ' });
    void this.reveal();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  private reportError(err: unknown): void {
    const e = err as ProtocolError;
    this.log.appendLine(`[evren] ${e.code ?? 'hata'}: ${e.message ?? String(err)}`);
    const text = e.code === 'busy' ? 'Tur sürerken bu işlem yapılamaz.' : `Evren: ${e.message ?? String(err)}`;
    void vscode.window.showWarningMessage(text);
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
<div id="banner" hidden></div>
<section id="todos" hidden></section>
<main id="log"></main>
<footer>
  <div id="working" hidden>
    <span class="spinner" aria-hidden="true"></span>
    <span id="stage">Düşünüyor</span>
    <span id="elapsed"></span>
    <span class="spacer"></span>
    <span class="hint">Esc ile durdur</span>
  </div>
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
    void this.proc?.stop();
    this.statusItem.dispose();
    this.events.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
