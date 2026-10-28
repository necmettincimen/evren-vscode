import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { ChildProcess } from 'child_process';
import { LineSplitter, encodeCommand, parseEvent, versionAtLeast, EvrenEvent } from '../cli/protocol';
import { EvrenProcess, ProtocolError, buildLaunch, LaunchSpec } from '../cli/EvrenProcess';

// --- Sahte alt süreç ---

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  pid = 1234;
  written: Record<string, unknown>[] = [];

  constructor() {
    super();
    const sp = new LineSplitter();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (d: string) => {
      for (const l of sp.push(d)) {
        const msg = JSON.parse(l);
        this.written.push(msg);
        this.emit('command', msg);
      }
    });
    this.stdin.on('finish', () => this.exit(0));
  }

  out(ev: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ v: 1, ...ev }) + '\n');
  }

  exit(code: number): void {
    if (this.exitCode !== null) {
      return;
    }
    this.exitCode = code;
    setImmediate(() => this.emit('exit', code, null));
  }

  kill(): boolean {
    this.killed = true;
    this.exit(1);
    return true;
  }
}

const SPEC: LaunchSpec = { command: 'evren', args: ['--stdio'], options: {} };

function make(): { proc: EvrenProcess; child: FakeChild } {
  const child = new FakeChild();
  const proc = new EvrenProcess(SPEC, {
    spawn: () => child as unknown as ChildProcess,
    readyTimeoutMs: 500,
    requestTimeoutMs: 500,
  });
  return { proc, child };
}

async function started(): Promise<{ proc: EvrenProcess; child: FakeChild }> {
  const t = make();
  const p = t.proc.start();
  t.child.out({ type: 'ready', id: 's1', version: '3.10.0', model: 'm', workspace: 'W', protocol: 1 });
  await p;
  return t;
}

const tick = () => new Promise((r) => setImmediate(r));

// --- Saf yardımcılar ---

test('LineSplitter parçalı veriyi ve CRLF satırlarını birleştirir', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":'), []);
  assert.deepEqual(s.push('1}\r\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(':2}\n\n'), ['{"b":2}', '']);
  assert.deepEqual(s.flush(), []);
  s.push('kalan');
  assert.deepEqual(s.flush(), ['kalan']);
});

test('parseEvent bozuk JSON, bilinmeyen tip ve farklı sürümü eler', () => {
  assert.equal(parseEvent('{bozuk'), undefined);
  assert.equal(parseEvent(''), undefined);
  assert.equal(parseEvent('[1]'), undefined);
  assert.equal(parseEvent('{"v":1,"type":"gelecek_olay"}'), undefined);
  assert.equal(parseEvent('{"v":2,"type":"turn_start"}'), undefined);
  const ev = parseEvent('{"v":1,"type":"assistant_delta","id":"s3","text":"merhaba ğüş"}');
  assert.deepEqual(ev, { v: 1, type: 'assistant_delta', id: 's3', text: 'merhaba ğüş' });
});

test('encodeCommand zarfı ve satır sonunu ekler', () => {
  const line = encodeCommand({ type: 'approval_response', request_id: 'r5', decision: 'allow', edited_content: 'x\ny' }, 'c1');
  assert.ok(line.endsWith('\n'));
  assert.equal(line.split('\n').length, 2, 'içerikteki satır sonu kaçırılmalı');
  assert.deepEqual(JSON.parse(line), {
    v: 1, type: 'approval_response', request_id: 'r5', decision: 'allow', edited_content: 'x\ny', id: 'c1',
  });
});

test('versionAtLeast', () => {
  assert.ok(versionAtLeast('3.10.0', '3.10.0'));
  assert.ok(versionAtLeast('3.10.1', '3.10.0'));
  assert.ok(versionAtLeast('4.0', '3.10.0'));
  assert.ok(!versionAtLeast('3.9.12', '3.10.0'));
  assert.ok(!versionAtLeast('2.99.99', '3.10.0'));
});

test('buildLaunch: kipler, izinli araçlar ve UTF-8 ortamı', () => {
  const base = { cliPath: 'evren', workspace: 'C:\\Proje Klasörü' };
  const a = buildLaunch({ ...base, model: 'glm', autoApprove: 'edits', allowedTools: ['grep'] }, {});
  assert.equal(a.command, 'evren');
  assert.deepEqual(a.args.slice(0, 5), ['--stdio', '--workspace', 'C:\\Proje Klasörü', '--model', 'glm']);
  const tools = a.args[a.args.indexOf('--allowed-tools') + 1].split(',');
  assert.ok(tools.includes('grep') && tools.includes('edit_file'));
  assert.ok(!a.args.includes('--yes'));
  assert.equal(a.options.shell, false);
  assert.equal((a.options.env as NodeJS.ProcessEnv).PYTHONIOENCODING, 'utf-8');
  assert.equal(a.options.cwd, 'C:\\Proje Klasörü');
  assert.equal((a.options.env as NodeJS.ProcessEnv).EVREN_AUTO_APPROVE, 'false');

  const b = buildLaunch({ ...base, autoApprove: 'all', extraEnv: { FOO: '1' } }, {});
  assert.ok(b.args.includes('--yes'));
  assert.ok(!b.args.includes('--allowed-tools'));
  assert.equal((b.options.env as NodeJS.ProcessEnv).FOO, '1');
  assert.equal((b.options.env as NodeJS.ProcessEnv).EVREN_AUTO_APPROVE, 'true');

  const c = buildLaunch({ ...base, pythonPath: 'python', cliRepo: 'D:\\evren-cli' }, {});
  assert.equal(c.command, 'python');
  assert.deepEqual(c.args.slice(0, 3), ['-m', 'src.cli', '--stdio']);
  assert.equal(c.options.cwd, 'D:\\evren-cli');
});

// --- EvrenProcess ---

test('start parçalı gelen ready olayını bekler', async () => {
  const { proc, child } = make();
  const p = proc.start();
  const line = JSON.stringify({ v: 1, type: 'ready', id: 's1', version: '3.10.0', model: 'm', workspace: 'W' }) + '\n';
  child.stdout.write(line.slice(0, 10));
  await tick();
  child.stdout.write(line.slice(10));
  const ready = await p;
  assert.equal(ready.model, 'm');
  assert.ok(proc.running);
});

test('eski CLI sürümü old_version ile reddedilir ve süreç durdurulur', async () => {
  const { proc, child } = make();
  const p = proc.start();
  child.out({ type: 'ready', version: '3.9.10', model: 'm', workspace: 'W' });
  await assert.rejects(p, (e: ProtocolError) => e.code === 'old_version');
  await tick();
  assert.notEqual(child.exitCode, null);
});

test('ready gelmezse ready_timeout', async () => {
  const { proc } = make();
  await assert.rejects(proc.start(), (e: ProtocolError) => e.code === 'ready_timeout');
});

test('request reply_to ile eşleşen olayı döner', async () => {
  const { proc, child } = await started();
  child.on('command', (m: { type: string; id: string }) => {
    if (m.type === 'list_models') {
      child.out({ type: 'models', id: 's9', reply_to: 'başka', models: ['yanlış'], current: 'x' });
      child.out({ type: 'models', id: 's10', reply_to: m.id, models: ['a', 'b'], current: 'a' });
    }
  });
  const ev = await proc.request({ type: 'list_models' }, 'models');
  assert.deepEqual(ev.models, ['a', 'b']);
});

test('request error olayında ProtocolError ile reddedilir', async () => {
  const { proc, child } = await started();
  child.on('command', (m: { id: string }) => {
    child.out({ type: 'error', reply_to: m.id, message: 'tur sürüyor', code: 'busy' });
  });
  await assert.rejects(proc.request({ type: 'new_session' }, 'session_loaded'), (e: ProtocolError) => e.code === 'busy');
});

test('tam tur akışı: prompt → delta → tool_call → onay → turn_end', async () => {
  const { proc, child } = await started();
  const seen: EvrenEvent[] = [];
  proc.on('event', (ev: EvrenEvent) => {
    seen.push(ev);
    if (ev.type === 'approval_request') {
      proc.send({ type: 'approval_response', request_id: ev.request_id, decision: 'allow', edited_content: 'yeni\n' });
    }
  });
  const done = new Promise<void>((r) => proc.on('event', (ev: EvrenEvent) => ev.type === 'turn_end' && r()));
  child.on('command', (m: { type: string; id: string; request_id?: string }) => {
    if (m.type === 'prompt') {
      child.out({ type: 'turn_start', reply_to: m.id });
      child.out({ type: 'reasoning_delta', text: 'düşün' });
      child.out({ type: 'assistant_delta', text: 'Merhaba' });
      child.out({ type: 'tool_call', call_id: 'c1', name: 'edit_file', args: { path: 'R.md' } });
      child.out({ type: 'file_change_proposed', request_id: 'r5', path: 'R.md', old_content: 'a', new_content: 'b' });
      child.out({ type: 'approval_request', request_id: 'r5', kind: 'edit', title: 't', detail: 'R.md' });
    } else if (m.type === 'approval_response') {
      child.out({ type: 'tool_result', call_id: 'c1', name: 'edit_file', ok: true, summary: 'ok', output_truncated: false });
      child.out({ type: 'usage', prompt_tokens: 10, completion_tokens: 2 });
      child.out({ type: 'turn_end', result: 'bitti', changed_files: ['R.md'], exit_code: 0 });
    }
  });
  proc.send({ type: 'prompt', text: 'README', mode: 'normal' });
  await done;
  assert.deepEqual(seen.map((e) => e.type), [
    'turn_start', 'reasoning_delta', 'assistant_delta', 'tool_call', 'file_change_proposed',
    'approval_request', 'tool_result', 'usage', 'turn_end',
  ]);
  const resp = child.written.find((m) => m.type === 'approval_response')!;
  assert.equal(resp.edited_content, 'yeni\n');
  assert.equal(resp.v, 1);
});

test('cancel komutu yazılır ve tur iptal edilmiş turn_end ile biter', async () => {
  const { proc, child } = await started();
  child.on('command', (m: { type: string }) => {
    if (m.type === 'cancel') {
      child.out({ type: 'turn_end', result: 'iptal', changed_files: [], exit_code: 1 });
    }
  });
  const end = new Promise<EvrenEvent>((r) => proc.on('event', (ev: EvrenEvent) => ev.type === 'turn_end' && r(ev)));
  proc.send({ type: 'cancel' });
  const ev = (await end) as Extract<EvrenEvent, { type: 'turn_end' }>;
  assert.equal(ev.exit_code, 1);
});

test('geçersiz satır protocolError olarak bildirilir, akış sürer; stderr ayrı gelir', async () => {
  const { proc, child } = await started();
  const bad: string[] = [];
  const errs: string[] = [];
  const evs: string[] = [];
  proc.on('protocolError', (l: string) => bad.push(l));
  proc.on('stderr', (s: string) => errs.push(s));
  proc.on('event', (e: EvrenEvent) => evs.push(e.type));
  child.stdout.write('rich çıktısı sızdı\n');
  child.stderr.write('log satırı\n');
  child.out({ type: 'todos', items: [{ content: 'a', status: 'pending' }] });
  await tick();
  assert.deepEqual(bad, ['rich çıktısı sızdı']);
  assert.deepEqual(errs, ['log satırı\n']);
  assert.deepEqual(evs, ['todos']);
});

test('süreç çökünce bekleyen istekler reddedilir ve exit beklenmedik olarak bildirilir', async () => {
  const { proc, child } = await started();
  const exited = new Promise<{ code: number; expected: boolean }>((r) => proc.once('exit', r));
  const req = proc.request({ type: 'list_sessions' }, 'sessions');
  child.exit(3);
  await assert.rejects(req, (e: ProtocolError) => e.code === 'exited');
  const info = await exited;
  assert.equal(info.code, 3);
  assert.equal(info.expected, false);
  assert.ok(!proc.running);
  assert.throws(() => proc.send({ type: 'cancel' }), (e: ProtocolError) => e.code === 'not_running');
});

test('stop stdin\'i kapatır, çıkış beklenen olarak bildirilir', async () => {
  const { proc } = await started();
  const exited = new Promise<{ expected: boolean }>((r) => proc.once('exit', r));
  await proc.stop(500);
  assert.equal((await exited).expected, true);
});

// --- Webview mesaj doğrulaması ---

import { parseInMsg } from '../chat/messages';

test('parseInMsg yalnız geçerli webview mesajlarını kabul eder', () => {
  assert.deepEqual(parseInMsg({ type: 'send', text: 'merhaba', extra: 1 }), { type: 'send', text: 'merhaba' });
  assert.deepEqual(parseInMsg({ type: 'approval', request_id: 'r1', decision: 'always' }), { type: 'approval', request_id: 'r1', decision: 'always' });
  assert.equal(parseInMsg({ type: 'approval', request_id: 'r1', decision: 'evet' }), undefined);
  assert.equal(parseInMsg({ type: 'send', text: 42 }), undefined);
  assert.equal(parseInMsg({ type: 'setMode', mode: 'yolo' }), undefined);
  assert.equal(parseInMsg({ type: 'readFile', path: '/etc/passwd' }), undefined);
  assert.equal(parseInMsg(null), undefined);
  assert.equal(parseInMsg('send'), undefined);
});
