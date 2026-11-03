// Tek bir sohbet sekmesi: kendi `evren --stdio` süreci, kipi, modeli ve bekleyen onayları.
// Birden çok sekme aynı anda çalışabilir; her biri ayrı süreçtir.

import * as vscode from 'vscode';
import { EvrenProcess, ProtocolError, buildLaunch } from '../cli/EvrenProcess';
import { Attachment, Decision, EvrenEvent, Mode } from '../cli/protocol';
import { DiffManager } from '../diff/DiffManager';
import { MODES } from './messages';

export type State = 'stopped' | 'starting' | 'ready' | 'crashed' | 'error';

/** ChatSession'ın dış dünyaya ihtiyaç duyduğu yüzey (webview, günlük, diff). */
export interface SessionHost {
  log: vscode.OutputChannel;
  diff: DiffManager;
  /** Webview'a `sid` eklenerek iletilir. */
  post(sid: string, msg: Record<string, unknown>): void;
  /** Sekme başlığı/durumu değişti: sekme çubuğu ve durum çubuğu yenilenir. */
  changed(): void;
  fire(ev: EvrenEvent): void;
}

export interface TabInfo {
  id: string;
  title: string;
  state: State;
  busy: boolean;
  /** Kullanıcıdan onay/yanıt bekliyor. */
  waiting: boolean;
}

export class ChatSession {
  proc?: EvrenProcess;
  state: State = 'stopped';
  busy = false;
  model = '';
  mode: Mode;
  version = '';
  tokens = 0;
  title = '';
  /** Devam ettirilen CLI oturumunun kimliği (yeni oturumda boş). */
  cliSessionId: string | null = null;
  private promptId?: string;
  private startP?: Promise<void>;
  private restartAfterTurn = false;
  private pendingApprovals = new Map<string, string>(); // request_id → kind
  private pendingAsks = new Set<string>();

  constructor(
    readonly id: string,
    private host: SessionHost,
    private root: string,
    defaultMode: Mode,
  ) {
    this.mode = defaultMode;
  }

  get info(): TabInfo {
    return {
      id: this.id,
      title: this.title || 'Yeni sohbet',
      state: this.state,
      busy: this.busy,
      waiting: this.pendingApprovals.size > 0 || this.pendingAsks.size > 0,
    };
  }

  /** Henüz hiç mesaj gitmemiş mi (boş sekme yeniden kullanılabilir)? */
  get pristine(): boolean {
    return !this.title && !this.busy && this.cliSessionId === null;
  }

  private diffKey(requestId: string): string {
    return `${this.id}:${requestId}`;
  }

  private post(msg: Record<string, unknown>): void {
    this.host.post(this.id, msg);
  }

  postStatus(message?: string): void {
    this.post({
      type: 'status', state: this.state, busy: this.busy, model: this.model, mode: this.mode,
      version: this.version, tokens: this.tokens, message,
    });
    this.host.changed();
  }

  // --- Süreç ---

  /** Süreci başlatır; zaten başlıyorsa aynı sözü döner. */
  start(): Promise<void> {
    if (!this.startP) {
      this.startP = this.doStart().finally(() => {
        this.startP = undefined;
      });
    }
    return this.startP;
  }

  private async doStart(): Promise<void> {
    if (this.proc?.running) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('evren');
    const launch = buildLaunch({
      cliPath: cfg.get<string>('cliPath', 'evren') || 'evren',
      pythonPath: cfg.get<string>('pythonPath', ''),
      cliRepo: cfg.get<string>('cliRepo', ''),
      workspace: this.root,
      model: cfg.get<string>('model', ''),
      autoApprove: cfg.get<'none' | 'edits' | 'all'>('autoApprove', 'none'),
      allowedTools: cfg.get<string[]>('allowedTools', []),
      extraEnv: cfg.get<Record<string, string>>('extraEnv', {}),
    });
    this.host.log.appendLine(`[evren:${this.id}] başlatılıyor: ${launch.command} ${launch.args.join(' ')} (cwd ${launch.options.cwd})`);
    const proc = new EvrenProcess(launch, { readyTimeoutMs: 60_000 });
    this.proc = proc;
    proc.on('stderr', (s: string) => this.host.log.append(s));
    proc.on('protocolError', (line: string) => this.host.log.appendLine(`[protokol] çözülemeyen satır: ${line.slice(0, 500)}`));
    proc.on('event', (ev: EvrenEvent) => this.onEvent(ev));
    proc.on('exit', (info: { code: number | null; signal: string | null; expected: boolean }) => this.onExit(proc, info));
    this.state = 'starting';
    this.postStatus();
    try {
      const ready = await proc.start();
      this.state = 'ready';
      this.model = ready.model;
      this.version = ready.version;
      this.host.log.appendLine(`[evren:${this.id}] hazır: ${ready.version}, model ${ready.model}, ${ready.workspace}`);
      if (this.mode !== 'normal') {
        await this.setMode(this.mode);
      }
      this.postStatus();
    } catch (err) {
      this.state = 'error';
      const e = err as ProtocolError;
      this.host.log.appendLine(`[evren:${this.id}] başlatma hatası (${e.code}): ${e.message}`);
      this.postStatus(e.message);
      await this.explainStartFailure(e);
    }
  }

  private async explainStartFailure(e: ProtocolError): Promise<void> {
    let text: string;
    if (e.code === 'spawn_failed') {
      text = 'evren CLI bulunamadı. Kurulum için README\'ye bakın ya da `evren.cliPath` ayarını tam yola çevirin.';
    } else if (e.code === 'old_version') {
      text = `${e.message}. CLI'yı güncelleyin (\`evren update\`).`;
    } else {
      text = `Evren başlatılamadı: ${e.message}`;
    }
    const pick = await vscode.window.showErrorMessage(text, 'Ayarlar', 'Logları göster', 'Yeniden dene');
    if (pick === 'Ayarlar') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'evren.');
    } else if (pick === 'Logları göster') {
      this.host.log.show(true);
    } else if (pick === 'Yeniden dene') {
      await this.restart();
    }
  }

  private onExit(proc: EvrenProcess, info: { code: number | null; signal: string | null; expected: boolean }): void {
    if (proc !== this.proc) {
      return;
    }
    this.host.log.appendLine(`[evren:${this.id}] süreç çıktı (kod ${info.code ?? info.signal})`);
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
    void vscode.window.showWarningMessage(`Evren CLI kapandı (${this.title || this.id}).`, 'Yeniden başlat', 'Logları göster').then((pick) => {
      if (pick === 'Yeniden başlat') {
        void this.restart();
      } else if (pick === 'Logları göster') {
        this.host.log.show(true);
      }
    });
  }

  private clearPending(): void {
    this.pendingApprovals.clear();
    this.pendingAsks.clear();
    void this.host.diff.closeByPrefix(`${this.id}:`);
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

  /** Ayar değişti: tur sürüyorsa bitince, değilse hemen yeniden başlat. */
  restartForSettings(): void {
    if (!this.proc?.running) {
      return;
    }
    if (this.busy) {
      this.restartAfterTurn = true;
      void vscode.window.showInformationMessage('Evren ayarı değişti; CLI tur bitince yeniden başlatılacak.');
    } else {
      void this.restart();
    }
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.busy = false;
    this.state = 'stopped';
    await this.host.diff.closeByPrefix(`${this.id}:`);
    await proc?.stop();
  }

  requireProc(): EvrenProcess | undefined {
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
        void this.host.diff
          .propose(this.diffKey(ev.request_id), ev.path, ev.old_content, ev.new_content)
          .catch((err) => this.host.log.appendLine(`[evren:${this.id}] diff açılamadı: ${(err as Error).message}`));
        // İçerik büyük olabilir; webview'a yalnız yol gider.
        this.post({ type: 'event', ev: { type: ev.type, request_id: ev.request_id, path: ev.path } });
        this.host.fire(ev);
        return;
      case 'approval_request':
        this.pendingApprovals.set(ev.request_id, ev.kind);
        this.host.changed();
        break;
      case 'ask_user':
        this.pendingAsks.add(ev.request_id);
        this.host.changed();
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
      case 'session_loaded':
        this.cliSessionId = ev.session_id;
        break;
      case 'error':
        this.host.log.appendLine(`[evren:${this.id}] hata ${ev.code}: ${ev.message}`);
        if (ev.reply_to && ev.reply_to === this.promptId && ev.code !== 'mention') {
          this.busy = false; // tur hiç başlamadı (busy, empty_prompt, internal)
          this.postStatus();
        }
        break;
    }
    this.post({ type: 'event', ev });
    this.host.fire(ev);
  }

  // --- Eylemler ---

  sendPrompt(text: string, attachments: Attachment[] = []): void {
    const proc = this.requireProc();
    if (!proc || !text.trim()) {
      return;
    }
    if (this.busy) {
      void vscode.window.showInformationMessage('Bu sekme hâlâ çalışıyor; önce durdurun, bitmesini bekleyin ya da yeni sekme açın.');
      return;
    }
    if (!this.title) {
      this.title = text.trim().replace(/\s+/g, ' ').slice(0, 40);
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

  answerAsk(requestId: string, answer: string): void {
    if (this.pendingAsks.delete(requestId)) {
      this.proc?.send({ type: 'ask_user_response', request_id: requestId, answer });
      this.host.changed();
    }
  }

  async answerApproval(requestId: string, decision: Decision): Promise<void> {
    if (!this.pendingApprovals.has(requestId) || !this.proc?.running) {
      return;
    }
    this.pendingApprovals.delete(requestId);
    const key = this.diffKey(requestId);
    let edited: string | undefined;
    if (decision !== 'deny' && this.host.diff.has(key)) {
      edited = await this.host.diff.editedContent(key);
    }
    this.proc.send({
      type: 'approval_response', request_id: requestId, decision,
      ...(edited !== undefined ? { edited_content: edited } : {}),
    });
    this.post({ type: 'approvalDone', request_id: requestId, decision, edited: edited !== undefined });
    await this.host.diff.close(key);
    this.host.changed();
  }

  showDiff(requestId: string): Promise<void> {
    return this.host.diff.show(this.diffKey(requestId));
  }

  async setMode(mode: Mode): Promise<void> {
    const proc = this.requireProc();
    if (!proc || !MODES.includes(mode)) {
      return;
    }
    try {
      await proc.request({ type: 'set_mode', mode }, 'mode_changed');
    } catch (err) {
      this.reportError(err);
      this.postStatus();
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

  /** Kayıtlı CLI oturumunu bu sekmeye yükler. */
  async resume(sessionId: string, title: string): Promise<void> {
    const proc = this.requireProc();
    if (!proc) {
      return;
    }
    try {
      await proc.request({ type: 'resume', session_id: sessionId }, 'session_loaded');
      this.title = title || sessionId;
      this.tokens = 0;
      this.postStatus();
    } catch (err) {
      this.reportError(err);
    }
  }

  /** Aynı sekmede boş bir oturum açar (süreç kalır). */
  async reset(): Promise<void> {
    const proc = this.requireProc();
    if (!proc) {
      return;
    }
    try {
      await proc.request({ type: 'new_session' }, 'session_loaded');
      this.title = '';
      this.tokens = 0;
      this.postStatus();
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    const e = err as ProtocolError;
    this.host.log.appendLine(`[evren:${this.id}] ${e.code ?? 'hata'}: ${e.message ?? String(err)}`);
    const text = e.code === 'busy' ? 'Tur sürerken bu işlem yapılamaz.' : `Evren: ${e.message ?? String(err)}`;
    void vscode.window.showWarningMessage(text);
  }
}
