// `file_change_proposed` için diff görünümü: sol salt okunur eski içerik (sanal belge),
// sağ düzenlenebilir geçici dosya. Kullanıcı sağı düzenlerse onayda `edited_content` olur.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export const ORIG_SCHEME = 'evren-orig';

interface Proposal {
  requestId: string;
  path: string;
  oldContent: string;
  newContent: string;
  origUri: vscode.Uri;
  proposedUri: vscode.Uri;
}

export class DiffManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private proposals = new Map<string, Proposal>();
  private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private registration: vscode.Disposable;

  constructor(private storageDir: string) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, this);
    fs.mkdirSync(storageDir, { recursive: true });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = new URLSearchParams(uri.query).get('r') ?? '';
    return this.proposals.get(id)?.oldContent ?? '';
  }

  has(requestId: string): boolean {
    return this.proposals.has(requestId);
  }

  async propose(requestId: string, filePath: string, oldContent: string, newContent: string): Promise<void> {
    const base = path.basename(filePath) || 'dosya';
    const dir = path.join(this.storageDir, requestId.replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const proposedPath = path.join(dir, base);
    fs.writeFileSync(proposedPath, newContent, 'utf8');
    const origUri = vscode.Uri.from({ scheme: ORIG_SCHEME, path: '/' + base, query: `r=${encodeURIComponent(requestId)}` });
    const proposedUri = vscode.Uri.file(proposedPath);
    this.proposals.set(requestId, { requestId, path: filePath, oldContent, newContent, origUri, proposedUri });
    await this.show(requestId);
  }

  async show(requestId: string): Promise<void> {
    const p = this.proposals.get(requestId);
    if (!p) {
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', p.origUri, p.proposedUri, `Evren: ${p.path} (önerilen ↔ mevcut)`, {
      preview: false,
    });
    await vscode.commands.executeCommand('setContext', 'evren.pendingDiff', true);
  }

  /** En son açılan bekleyen önerinin kimliği (editör başlık düğmeleri için). */
  latest(): string | undefined {
    return [...this.proposals.keys()].pop();
  }

  /**
   * Sağ taraftaki güncel metni döner (kaydedilmemiş düzenlemeler dahil).
   * Önerilenle aynıysa `undefined`: CLI kendi içeriğini yazar.
   */
  async editedContent(requestId: string): Promise<string | undefined> {
    const p = this.proposals.get(requestId);
    if (!p) {
      return undefined;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === p.proposedUri.toString());
    const text = open ? open.getText() : fs.readFileSync(p.proposedUri.fsPath, 'utf8');
    return normalizeEol(text, p.newContent) === p.newContent ? undefined : normalizeEol(text, p.newContent);
  }

  /** Diff sekmesini kapatır, geçici dosyayı siler. */
  async close(requestId: string): Promise<void> {
    const p = this.proposals.get(requestId);
    if (!p) {
      return;
    }
    this.proposals.delete(requestId);
    const target = p.proposedUri.toString();
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === target);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target);
    if (doc?.isDirty) {
      // Kaydet sorusu çıkmasın: tampon diske yazılıp sonra silinir.
      await doc.save();
    }
    if (tabs.length) {
      await vscode.window.tabGroups.close(tabs, true);
    }
    try {
      // Windows'ta sekme kapandıktan hemen sonra dosya kilitli kalabilir.
      fs.rmSync(path.dirname(p.proposedUri.fsPath), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Sonraki öneri aynı dosyanın üzerine yazar; artık kalması zararsız.
    }
    if (!this.proposals.size) {
      await vscode.commands.executeCommand('setContext', 'evren.pendingDiff', false);
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.proposals.keys()]) {
      await this.close(id);
    }
  }

  dispose(): void {
    void this.closeAll();
    this.registration.dispose();
    this.changeEmitter.dispose();
  }
}

/** Editör CRLF'e çevirdiyse önerinin satır sonuna geri döndür. */
function normalizeEol(text: string, reference: string): string {
  if (!reference.includes('\r\n') && text.includes('\r\n')) {
    return text.replace(/\r\n/g, '\n');
  }
  return text;
}
