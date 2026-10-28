// Arka planda çalışan Evren ajanlarını bulur: işletim sistemi süreçleri + `evren plan` ajan günlükleri.
// vscode modülüne bağımlı değildir; birim testleri düz Node ile çalışır.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type AgentKind = 'plan' | 'agent' | 'stdio' | 'repl';

export interface RawProcess {
  pid: number;
  ppid: number;
  commandLine: string;
  /** Başlangıç zamanı (ms, epoch); bilinmiyorsa undefined. */
  startedAt?: number;
}

export interface AgentProcess extends RawProcess {
  kind: AgentKind;
  workspace?: string;
  model?: string;
  prompt?: string;
  planFile?: string;
  maxSteps?: number;
  children: AgentProcess[];
}

export interface AgentLog {
  file: string;
  /** reports/agent-logs/<etiket>-a<deneme>.log */
  label: string;
  attempt: number;
  mtime: number;
  size: number;
  lastLine: string;
  /** Son ACTIVE_LOG_MS içinde yazıldıysa çalışıyor sayılır. */
  active: boolean;
}

export const ACTIVE_LOG_MS = 90_000;

/** Windows komut satırını argümanlara ayırır (CommandLineToArgvW kurallarının sade hali). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) {
          cur += '"';
        } else {
          quoted = !quoted;
        }
        i += n;
      } else {
        cur += '\\'.repeat(n);
        i += n - 1;
      }
      has = true;
    } else if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (/\s/.test(c) && !quoted) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const EVREN_EXE = /^evren(-cli)?(\.exe|\.cmd|\.bat)?$/i;
const PYTHON_EXE = /^python[\d.]*(w)?(\.exe)?$|^py(\.exe)?$/i;

/** Komut satırı Evren'e aitse türünü ve ayrıntılarını döner; değilse undefined. */
export function parseEvrenCommandLine(commandLine: string): Omit<AgentProcess, keyof RawProcess | 'children'> | undefined {
  const argv = splitCommandLine(commandLine);
  if (!argv.length) return undefined;
  const exe = path.basename(argv[0].replace(/\\/g, '/'));
  let rest: string[];
  if (EVREN_EXE.test(exe)) {
    rest = argv.slice(1);
  } else if (PYTHON_EXE.test(exe)) {
    const m = argv.findIndex((a, i) => a === 'src.cli' && argv[i - 1] === '-m');
    if (m < 0) return undefined;
    rest = argv.slice(m + 1);
  } else {
    return undefined;
  }
  const info: Omit<AgentProcess, keyof RawProcess | 'children'> = { kind: 'repl' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = rest[i + 1];
    if (a === '--stdio') {
      info.kind = 'stdio';
    } else if ((a === '-w' || a === '--workspace') && next !== undefined) {
      info.workspace = next;
      i++;
    } else if ((a === '-m' || a === '--model') && next !== undefined) {
      info.model = next;
      i++;
    } else if ((a === '-p' || a === '--prompt') && next !== undefined) {
      info.prompt = next;
      if (info.kind === 'repl') info.kind = 'agent';
      i++;
    } else if (a === '--max-steps' && next !== undefined) {
      info.maxSteps = Number(next) || undefined;
      i++;
    } else if (a === 'plan' && i === 0) {
      info.kind = 'plan';
      if (next && !next.startsWith('-')) {
        info.planFile = next;
        i++;
      }
    }
  }
  return info;
}

/**
 * Evren süreçlerini ebeveyn-çocuk ağacına dizer. Evren olmayan aradaki süreçler (ör. launcher'ın
 * açtığı python) atlanır: çocuk, en yakın Evren atasına bağlanır. Aynı argümanlı launcher→python
 * çifti tek düğüme indirgenir.
 */
export function buildAgentTree(all: RawProcess[]): AgentProcess[] {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const agents = new Map<number, AgentProcess>();
  for (const p of all) {
    const info = parseEvrenCommandLine(p.commandLine);
    if (info) agents.set(p.pid, { ...p, ...info, children: [] });
  }
  const parentOf = (a: AgentProcess): AgentProcess | undefined => {
    const seen = new Set<number>([a.pid]);
    for (let pp = a.ppid; !seen.has(pp); pp = byPid.get(pp)!.ppid) {
      seen.add(pp);
      if (agents.has(pp)) return agents.get(pp);
      if (!byPid.has(pp)) return undefined;
    }
    return undefined;
  };
  // launcher → gerçek süreç aynı argümanlarla ise çocuk ebeveynin takma adı olur (durdurma ağacı öldürür).
  const alias = new Map<number, AgentProcess>();
  for (const a of agents.values()) {
    const p = parentOf(a);
    if (p && sameInvocation(p, a)) alias.set(a.pid, p);
  }
  const rep = (a: AgentProcess): AgentProcess => {
    while (alias.has(a.pid)) a = alias.get(a.pid)!;
    return a;
  };
  const roots: AgentProcess[] = [];
  for (const a of agents.values()) {
    if (alias.has(a.pid)) continue;
    const p = parentOf(a);
    (p ? rep(p).children : roots).push(a);
  }
  const byStart = (x: AgentProcess, y: AgentProcess) => (x.startedAt ?? 0) - (y.startedAt ?? 0);
  agents.forEach((a) => a.children.sort(byStart));
  return roots.sort(byStart);
}

function sameInvocation(a: AgentProcess, b: AgentProcess): boolean {
  return a.kind === b.kind && a.workspace === b.workspace && a.prompt === b.prompt && a.planFile === b.planFile && a.model === b.model;
}

/** PowerShell `ConvertTo-Json` çıktısını (tek nesne ya da dizi) okur. */
export function parseWindowsProcessJson(json: string): RawProcess[] {
  if (!json.trim()) return [];
  const data = JSON.parse(json) as unknown;
  const list = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  return list
    .filter((r) => r && typeof r.ProcessId === 'number')
    .map((r) => ({
      pid: r.ProcessId as number,
      ppid: (r.ParentProcessId as number) ?? 0,
      commandLine: String(r.CommandLine ?? ''),
      startedAt: parseCimDate(r.CreationDate),
    }));
}

function parseCimDate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /\/Date\((\d+)\)\//.exec(v);
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** `ps -eo pid=,ppid=,etimes=,args=` çıktısını okur. */
export function parsePsOutput(text: string, now = Date.now()): RawProcess[] {
  const out: RawProcess[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], startedAt: now - +m[3] * 1000, commandLine: m[4].trim() });
  }
  return out;
}

const WIN_QUERY =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "Get-CimInstance Win32_Process -Filter \"Name like 'evren%' or Name like 'python%' or Name like 'py.exe' or Name like 'cmd.exe'\" | " +
  'Select-Object ProcessId,ParentProcessId,CommandLine,@{n="CreationDate";e={$_.CreationDate.ToString("o")}} | ConvertTo-Json -Compress';

/** Evren ile ilgili olabilecek süreçleri listeler (Windows: CIM, diğerleri: ps). */
export function listProcesses(timeoutMs = 10_000): Promise<RawProcess[]> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(err);
          try {
            resolve(parseWindowsProcessJson(stdout));
          } catch (e) {
            reject(e);
          }
        });
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(parsePsOutput(stdout));
      });
    }
  });
}

/** Süreci ve tüm alt ağacını sonlandırır. */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (e) {
          return reject(e);
        }
      }
      resolve();
    }
  });
}

const LOG_NAME = /^(.*)-a(\d+)\.log$/;

/** `<kök>/reports/agent-logs/*.log` dosyalarını en yeniden eskiye döner. */
export function scanAgentLogs(roots: string[], now = Date.now(), limit = 50): AgentLog[] {
  const logs: AgentLog[] = [];
  for (const root of roots) {
    const dir = path.join(root, 'reports', 'agent-logs');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = LOG_NAME.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        logs.push({
          file,
          label: m[1],
          attempt: Number(m[2]),
          mtime: st.mtimeMs,
          size: st.size,
          lastLine: lastLine(file, st.size),
          active: now - st.mtimeMs < ACTIVE_LOG_MS,
        });
      } catch {
        // Dosya o anda silinmiş/kilitli olabilir.
      }
    }
  }
  return logs.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** Büyük günlüğü baştan okumadan son boş olmayan satırı döner. */
export function lastLine(file: string, size: number, tailBytes = 8192): string {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = stripAnsi(buf.toString('utf8')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  } finally {
    fs.closeSync(fd);
  }
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
}

/** "3 dk 12 sn" biçiminde süre. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${s % 60} sn`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}
