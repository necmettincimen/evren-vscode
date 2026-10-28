// "Ajanlar" ağaç görünümü: makinede çalışan Evren süreçleri (plan, başsız ajan, stdio, REPL)
// ve `evren plan` ajan günlükleri. Görünürken birkaç saniyede bir yenilenir.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AgentLog,
  AgentProcess,
  buildAgentTree,
  formatDuration,
  killProcessTree,
  listProcesses,
  RawProcess,
  scanAgentLogs,
} from './scan';

export type AgentNode =
  | { type: 'section'; id: 'processes' | 'logs' }
  | { type: 'process'; proc: AgentProcess }
  | { type: 'log'; log: AgentLog }
  | { type: 'message'; text: string; icon?: string };

const REFRESH_MS = 5000;

export interface AgentsSnapshot {
  processes: AgentProcess[];
  logs: AgentLog[];
  error?: string;
  at: number;
}

export class AgentsView implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable {
  static readonly viewId = 'evren.agents';
  private changed = new vscode.EventEmitter<AgentNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private view?: vscode.TreeView<AgentNode>;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<AgentsSnapshot>;
  snapshot: AgentsSnapshot = { processes: [], logs: [], at: 0 };

  constructor(
    /** Bu pencerenin stdio sürecinin pid'i: listede işaretlenir. */
    private ownPid: () => number | undefined,
    private list: () => Promise<RawProcess[]> = () => listProcesses(),
  ) {}

  attach(view: vscode.TreeView<AgentNode>): vscode.Disposable {
    this.view = view;
    const sync = () => {
      clearInterval(this.timer);
      this.timer = undefined;
      if (view.visible) {
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
      }
    };
    sync();
    return view.onDidChangeVisibility(sync);
  }

  /** Süreçleri ve günlükleri yeniden tarar; aynı anda tek tarama çalışır. */
  refresh(): Promise<AgentsSnapshot> {
    if (!this.inflight) {
      this.inflight = this.scan().finally(() => (this.inflight = undefined));
    }
    return this.inflight;
  }

  private async scan(): Promise<AgentsSnapshot> {
    let processes: AgentProcess[] = [];
    let error: string | undefined;
    try {
      processes = buildAgentTree(await this.list());
    } catch (e) {
      error = (e as Error).message;
    }
    const logs = scanAgentLogs(this.logRoots(processes));
    this.snapshot = { processes, logs, error, at: Date.now() };
    const running = countAgents(processes) + logs.filter((l) => l.active).length;
    if (this.view) {
      this.view.badge = running ? { value: running, tooltip: `${running} Evren ajanı çalışıyor` } : undefined;
      this.view.description = processes.length ? `${countAgents(processes)} süreç` : undefined;
    }
    this.changed.fire(undefined);
    return this.snapshot;
  }

  /** Günlük kökleri: çalışma alanı klasörleri + süreçlerin çalışma dizinleri ve üç üst dizini. */
  private logRoots(processes: AgentProcess[]): string[] {
    const roots = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    const walk = (list: AgentProcess[]) =>
      list.forEach((p) => {
        let dir = p.workspace;
        for (let i = 0; dir && i < 4; i++) {
          if (fs.existsSync(path.join(dir, 'reports', 'agent-logs'))) roots.add(dir);
          const up = path.dirname(dir);
          dir = up === dir ? undefined : up;
        }
        walk(p.children);
      });
    walk(processes);
    return [...roots];
  }

  getChildren(node?: AgentNode): AgentNode[] {
    const s = this.snapshot;
    if (!node) {
      return [{ type: 'section', id: 'processes' }, { type: 'section', id: 'logs' }];
    }
    if (node.type === 'section' && node.id === 'processes') {
      if (s.error) return [{ type: 'message', text: `Süreçler okunamadı: ${s.error}`, icon: 'warning' }];
      if (!s.at) return [{ type: 'message', text: 'Taranıyor…', icon: 'loading~spin' }];
      if (!s.processes.length) return [{ type: 'message', text: 'Çalışan Evren süreci yok' }];
      return s.processes.map((proc) => ({ type: 'process', proc }));
    }
    if (node.type === 'section') {
      if (!s.logs.length) return [{ type: 'message', text: 'reports/agent-logs altında günlük yok' }];
      return s.logs.map((log) => ({ type: 'log', log }));
    }
    if (node.type === 'process') {
      return node.proc.children.map((proc) => ({ type: 'process', proc }));
    }
    return [];
  }

  getTreeItem(node: AgentNode): vscode.TreeItem {
    switch (node.type) {
      case 'section': {
        const isProc = node.id === 'processes';
        const n = isProc ? countAgents(this.snapshot.processes) : this.snapshot.logs.length;
        const active = isProc ? 0 : this.snapshot.logs.filter((l) => l.active).length;
        const item = new vscode.TreeItem(
          isProc ? `Süreçler (${n})` : `Ajan günlükleri (${n}${active ? `, ${active} aktif` : ''})`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `section:${node.id}`;
        item.iconPath = new vscode.ThemeIcon(isProc ? 'server-process' : 'output');
        item.contextValue = `evrenSection.${node.id}`;
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case 'process':
        return this.processItem(node.proc);
      case 'log':
        return logItem(node.log);
    }
  }

  private processItem(p: AgentProcess): vscode.TreeItem {
    const own = p.pid === this.ownPid();
    const item = new vscode.TreeItem(
      processLabel(p) + (own ? ' (bu pencere)' : ''),
      p.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `proc:${p.pid}`;
    const parts = [p.model, p.startedAt ? formatDuration(Date.now() - p.startedAt) : undefined, p.workspace && path.basename(p.workspace)];
    item.description = parts.filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      { plan: 'checklist', agent: 'sync~spin', stdio: 'comment-discussion', repl: 'terminal' }[p.kind],
    );
    item.contextValue = own ? 'evrenProcess.own' : 'evrenProcess';
    item.tooltip = processTooltip(p, own);
    return item;
  }

  /** Süreç ağacını sonlandırır; `confirm` false değilse önce onay ister. */
  async stop(node: AgentNode | undefined, opts: { confirm?: boolean } = {}): Promise<boolean> {
    if (node?.type !== 'process') return false;
    const p = node.proc;
    if (opts.confirm !== false) {
      const pick = await vscode.window.showWarningMessage(
        `"${processLabel(p)}" (pid ${p.pid}) ve alt süreçleri sonlandırılsın mı?`,
        { modal: true, detail: 'Ajanın yarım kalan değişiklikleri çalışma ağacında kalabilir.' },
        'Sonlandır',
      );
      if (pick !== 'Sonlandır') return false;
    }
    try {
      await killProcessTree(p.pid);
    } catch (e) {
      void vscode.window.showErrorMessage(`Süreç sonlandırılamadı: ${(e as Error).message}`);
      return false;
    }
    await this.refresh();
    return true;
  }

  async openLog(node: AgentNode | AgentLog | undefined): Promise<void> {
    const log = node && 'type' in node ? (node.type === 'log' ? node.log : undefined) : node;
    if (!log) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(log.file));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const end = doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
  }

  async copyPrompt(node: AgentNode | undefined): Promise<void> {
    if (node?.type === 'process' && node.proc.prompt) {
      await vscode.env.clipboard.writeText(node.proc.prompt);
      void vscode.window.setStatusBarMessage('Evren: istem kopyalandı', 2000);
    }
  }

  async openWorkspace(node: AgentNode | undefined): Promise<void> {
    if (node?.type === 'process' && node.proc.workspace) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.proc.workspace));
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.changed.dispose();
  }
}

export function countAgents(list: AgentProcess[]): number {
  return list.reduce((n, p) => n + 1 + countAgents(p.children), 0);
}

export function processLabel(p: AgentProcess): string {
  switch (p.kind) {
    case 'plan':
      return `Plan: ${p.planFile ? path.basename(p.planFile) : '?'}`;
    case 'agent':
      return oneLine(p.prompt ?? 'Başsız ajan', 70);
    case 'stdio':
      return 'Sohbet (stdio)';
    case 'repl':
      return 'Etkileşimli oturum';
  }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function processTooltip(p: AgentProcess, own: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${processLabel(p)}**${own ? ' — bu pencerenin sohbet süreci' : ''}\n\n`);
  const rows: [string, string | undefined][] = [
    ['PID', String(p.pid)],
    ['Tür', p.kind],
    ['Model', p.model],
    ['Çalışma dizini', p.workspace],
    ['Plan', p.planFile],
    ['Adım sınırı', p.maxSteps ? String(p.maxSteps) : undefined],
    ['Başlangıç', p.startedAt ? new Date(p.startedAt).toLocaleString() : undefined],
    ['Süre', p.startedAt ? formatDuration(Date.now() - p.startedAt) : undefined],
  ];
  for (const [k, v] of rows) {
    if (v) md.appendMarkdown(`- ${k}: \`${v.replace(/`/g, "'")}\`\n`);
  }
  if (p.prompt) {
    md.appendMarkdown('\n**İstem**\n');
    md.appendCodeblock(p.prompt.length > 1500 ? p.prompt.slice(0, 1500) + '\n…' : p.prompt, 'text');
  }
  return md;
}

function logItem(l: AgentLog): vscode.TreeItem {
  const item = new vscode.TreeItem(`${l.label} #${l.attempt}`);
  item.id = `log:${l.file}`;
  const ago = formatDuration(Date.now() - l.mtime);
  item.description = l.active ? `aktif · ${oneLine(l.lastLine, 80)}` : `${ago} önce · ${oneLine(l.lastLine, 60)}`;
  item.iconPath = new vscode.ThemeIcon(l.active ? 'sync~spin' : 'file');
  item.resourceUri = vscode.Uri.file(l.file);
  item.contextValue = 'evrenLog';
  item.command = { command: 'evren.agents.openLog', title: 'Günlüğü aç', arguments: [{ type: 'log', log: l }] };
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${l.label}** — deneme ${l.attempt}${l.active ? ' (aktif)' : ''}\n\n`);
  md.appendMarkdown(`- Dosya: \`${l.file}\`\n- Boyut: ${(l.size / 1024).toFixed(1)} KB\n- Son yazma: ${new Date(l.mtime).toLocaleString()} (${ago} önce)\n`);
  if (l.lastLine) md.appendCodeblock(l.lastLine.slice(0, 500), 'text');
  item.tooltip = md;
  return item;
}
