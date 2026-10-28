// `evren --stdio` sürecini yönetir: başlatma, NDJSON okuma/yazma, istek/yanıt eşleme, çökme.
// vscode modülüne bağımlı değildir; birim testleri düz Node ile çalışır.

import { spawn as nodeSpawn, ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import {
  Command,
  EventOf,
  EventType,
  EvrenEvent,
  LineSplitter,
  MIN_CLI_VERSION,
  encodeCommand,
  parseEvent,
  versionAtLeast,
} from './protocol';

export interface LaunchConfig {
  cliPath: string;
  pythonPath?: string;
  cliRepo?: string;
  workspace: string;
  model?: string;
  autoApprove?: 'none' | 'edits' | 'all';
  allowedTools?: string[];
  extraEnv?: Record<string, string>;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export const EDIT_TOOLS = ['edit_file', 'write_file', 'create_file', 'replace_in_file', 'apply_patch'];

/** Ayarlardan spawn parametrelerini üretir. Windows'ta shell kullanılmaz; .cmd/.bat istisnadır. */
export function buildLaunch(cfg: LaunchConfig, baseEnv: NodeJS.ProcessEnv = process.env): LaunchSpec {
  const cliArgs = ['--stdio', '--workspace', cfg.workspace];
  if (cfg.model) {
    cliArgs.push('--model', cfg.model);
  }
  if (cfg.autoApprove === 'all') {
    cliArgs.push('--yes');
  }
  const tools = new Set(cfg.allowedTools ?? []);
  if (cfg.autoApprove === 'edits') {
    EDIT_TOOLS.forEach((t) => tools.add(t));
  }
  if (tools.size) {
    cliArgs.push('--allowed-tools', [...tools].join(','));
  }
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...(cfg.extraEnv ?? {}),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    NO_COLOR: '1',
    // CLI'da varsayılan "true": onaylar yalnız autoApprove=all iken atlanır.
    EVREN_AUTO_APPROVE: cfg.autoApprove === 'all' ? 'true' : 'false',
  };
  if (cfg.pythonPath) {
    return {
      command: cfg.pythonPath,
      args: ['-m', 'src.cli', ...cliArgs],
      options: { cwd: cfg.cliRepo || cfg.workspace, env, shell: false, windowsHide: true },
    };
  }
  const ext = path.extname(cfg.cliPath).toLowerCase();
  const needsShell = process.platform === 'win32' && (ext === '.cmd' || ext === '.bat');
  return {
    command: needsShell ? quoteWin(cfg.cliPath) : cfg.cliPath,
    args: needsShell ? cliArgs.map(quoteWin) : cliArgs,
    options: { cwd: cfg.workspace, env, shell: needsShell, windowsHide: true },
  };
}

function quoteWin(s: string): string {
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export class ProtocolError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

interface Pending {
  replyType: EventType;
  resolve: (ev: EvrenEvent) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface EvrenProcessOptions {
  spawn?: SpawnFn;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Olaylar: 'event' (EvrenEvent), 'stderr' (string), 'exit' ({code, signal, expected}),
 * 'protocolError' (geçersiz satır).
 */
export class EvrenProcess extends EventEmitter {
  private child?: ChildProcess;
  private splitter = new LineSplitter();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stopping = false;
  ready?: EventOf<'ready'>;

  constructor(private launch: LaunchSpec, private opts: EvrenProcessOptions = {}) {
    super();
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** Süreci başlatır, `ready` olayını bekler. Eski sürümde ProtocolError('old_version'). */
  start(): Promise<EventOf<'ready'>> {
    if (this.child) {
      throw new Error('süreç zaten çalışıyor');
    }
    this.stopping = false;
    this.ready = undefined;
    this.splitter = new LineSplitter();
    const spawn = this.opts.spawn ?? (nodeSpawn as SpawnFn);
    const child = spawn(this.launch.command, this.launch.args, {
      ...this.launch.options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => this.onStdout(d));
    child.stderr?.on('data', (d: string) => this.emit('stderr', d));
    child.stdin?.on('error', () => undefined);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(new ProtocolError(`evren ${this.opts.readyTimeoutMs ?? 30000} ms içinde hazır olmadı`, 'ready_timeout'));
      }, this.opts.readyTimeoutMs ?? 30000);
      const finish = (err?: Error, ev?: EventOf<'ready'>) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.off('event', onEvent);
        if (err) {
          this.stop();
          reject(err);
        } else {
          resolve(ev!);
        }
      };
      const onEvent = (ev: EvrenEvent) => {
        if (ev.type !== 'ready') {
          return;
        }
        if (!versionAtLeast(ev.version, MIN_CLI_VERSION)) {
          finish(new ProtocolError(`evren ${ev.version} eski; en az ${MIN_CLI_VERSION} gerekli`, 'old_version'));
          return;
        }
        this.ready = ev;
        finish(undefined, ev);
      };
      this.on('event', onEvent);
      child.once('error', (err) => {
        if (child.pid === undefined && this.child === child) {
          this.child = undefined; // ENOENT: 'exit' gelmeyebilir
        }
        finish(new ProtocolError(`evren başlatılamadı: ${err.message}`, 'spawn_failed'));
      });
      child.once('exit', (code, signal) => {
        finish(new ProtocolError(`evren hazır olmadan çıktı (kod ${code ?? signal})`, 'exited'));
        this.onExit(code, signal);
      });
    });
  }

  private onStdout(chunk: string): void {
    for (const line of this.splitter.push(chunk)) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    const ev = parseEvent(line);
    if (!ev) {
      this.emit('protocolError', line);
      return;
    }
    if (ev.reply_to && this.pending.has(ev.reply_to)) {
      const p = this.pending.get(ev.reply_to)!;
      if (ev.type === p.replyType) {
        this.settle(ev.reply_to);
        p.resolve(ev);
      } else if (ev.type === 'error') {
        this.settle(ev.reply_to);
        p.reject(new ProtocolError(ev.message, ev.code));
      }
    }
    this.emit('event', ev);
  }

  private settle(id: string): void {
    const p = this.pending.get(id);
    if (p?.timer) {
      clearTimeout(p.timer);
    }
    this.pending.delete(id);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const line of this.splitter.flush()) {
      this.handleLine(line);
    }
    for (const [id, p] of [...this.pending]) {
      this.settle(id);
      p.reject(new ProtocolError('evren süreci sonlandı', 'exited'));
    }
    this.child = undefined;
    this.emit('exit', { code, signal, expected: this.stopping });
  }

  nextId(prefix = 'c'): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  /** Komutu yazar, kullandığı id'yi döner. */
  send(cmd: Command, id: string = this.nextId()): string {
    if (!this.child?.stdin || !this.child.stdin.writable) {
      throw new ProtocolError('evren süreci çalışmıyor', 'not_running');
    }
    this.child.stdin.write(encodeCommand(cmd, id), 'utf8');
    return id;
  }

  /** Komutu gönderir, `reply_to` eşleşen `replyType` olayını bekler; `error` gelirse reddeder. */
  request<T extends EventType>(cmd: Command, replyType: T, timeoutMs?: number): Promise<EventOf<T>> {
    const id = this.nextId('q');
    return new Promise<EventOf<T>>((resolve, reject) => {
      const ms = timeoutMs ?? this.opts.requestTimeoutMs ?? 30000;
      const p: Pending = { replyType, resolve: resolve as (ev: EvrenEvent) => void, reject };
      p.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolError(`${cmd.type} yanıtı ${ms} ms içinde gelmedi`, 'timeout'));
      }, ms);
      this.pending.set(id, p);
      try {
        this.send(cmd, id);
      } catch (err) {
        this.settle(id);
        reject(err as Error);
      }
    });
  }

  /** stdin'i kapatır (CLI turu iptal edip çıkar); süre dolarsa öldürür. */
  stop(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    this.stopping = true;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.stdin?.end();
      } catch {
        child.kill();
      }
    });
  }
}
