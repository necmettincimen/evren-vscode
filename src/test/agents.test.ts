import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAgentTree,
  formatDuration,
  lastLine,
  parseEvrenCommandLine,
  parsePsOutput,
  parseWindowsProcessJson,
  RawProcess,
  scanAgentLogs,
  splitCommandLine,
} from '../agents/scan';

test('splitCommandLine Windows tırnak ve ters bölü kuralları', () => {
  assert.deepEqual(splitCommandLine('a "b c" d'), ['a', 'b c', 'd']);
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\x.exe" -p "say \\"hi\\""'), ['C:\\Program Files\\x.exe', '-p', 'say "hi"']);
  assert.deepEqual(splitCommandLine('x "" y'), ['x', '', 'y']);
  assert.deepEqual(splitCommandLine('x "C:\\dir\\\\" y'), ['x', 'C:\\dir\\', 'y']);
  assert.deepEqual(splitCommandLine('  '), []);
});

test('parseEvrenCommandLine türleri ayırır', () => {
  const agent = parseEvrenCommandLine(
    'C:\\Py\\python.exe -m src.cli -w "D:\\iş yeri\\wt" --yes --max-steps 80 -m mimo-v2.6-pro -p "README düzelt\nrapor yaz"',
  );
  assert.deepEqual(agent, { kind: 'agent', workspace: 'D:\\iş yeri\\wt', maxSteps: 80, model: 'mimo-v2.6-pro', prompt: 'README düzelt\nrapor yaz' });
  assert.deepEqual(parseEvrenCommandLine('"C:\\Users\\u\\.evren-cli\\bin\\evren.exe" plan plans/x.json --from 3'), {
    kind: 'plan', planFile: 'plans/x.json',
  });
  assert.equal(parseEvrenCommandLine('evren --stdio --workspace /w')?.kind, 'stdio');
  assert.equal(parseEvrenCommandLine('/usr/bin/evren-cli')?.kind, 'repl');
  assert.equal(parseEvrenCommandLine('python3 -m http.server'), undefined);
  assert.equal(parseEvrenCommandLine('python app.py src.cli'), undefined);
  assert.equal(parseEvrenCommandLine('node evren.js'), undefined);
  assert.equal(parseEvrenCommandLine(''), undefined);
});

test('buildAgentTree: plan altında ajanlar, launcher çifti birleşir, aradaki süreç atlanır', () => {
  const procs: RawProcess[] = [
    { pid: 1, ppid: 0, commandLine: 'explorer.exe' },
    { pid: 10, ppid: 1, commandLine: 'evren.exe plan p.json', startedAt: 100 },
    { pid: 11, ppid: 10, commandLine: 'python.exe -m src.cli plan p.json', startedAt: 101 },
    { pid: 12, ppid: 11, commandLine: 'python.exe -m src.cli -w /a -p "iş B"', startedAt: 300 },
    { pid: 13, ppid: 11, commandLine: 'python.exe -m src.cli -w /a -p "iş A"', startedAt: 200 },
    { pid: 20, ppid: 1, commandLine: 'cmd.exe /c x' },
    { pid: 21, ppid: 20, commandLine: 'evren --stdio --workspace /w', startedAt: 50 },
    { pid: 30, ppid: 999, commandLine: 'python -m http.server' },
  ];
  const tree = buildAgentTree(procs);
  assert.deepEqual(tree.map((n) => [n.pid, n.kind]), [[21, 'stdio'], [10, 'plan']]);
  const plan = tree[1];
  assert.deepEqual(plan.children.map((c) => [c.pid, c.prompt]), [[13, 'iş A'], [12, 'iş B']]);
});

test('buildAgentTree döngülü ppid ile takılmaz', () => {
  const tree = buildAgentTree([
    { pid: 5, ppid: 6, commandLine: 'evren -p a' },
    { pid: 6, ppid: 5, commandLine: 'bash' },
  ]);
  assert.equal(tree.length, 1);
});

test('parseWindowsProcessJson tek nesne, dizi ve boş çıktı', () => {
  assert.deepEqual(parseWindowsProcessJson(''), []);
  const one = parseWindowsProcessJson('{"ProcessId":4,"ParentProcessId":1,"CommandLine":null,"CreationDate":"2026-10-28T10:00:00.0000000+03:00"}');
  assert.equal(one.length, 1);
  assert.equal(one[0].commandLine, '');
  assert.equal(one[0].startedAt, Date.parse('2026-10-28T10:00:00+03:00'));
  const many = parseWindowsProcessJson('[{"ProcessId":1,"ParentProcessId":0,"CommandLine":"a","CreationDate":"/Date(1000)/"},{"x":1}]');
  assert.deepEqual(many, [{ pid: 1, ppid: 0, commandLine: 'a', startedAt: 1000 }]);
});

test('parsePsOutput', () => {
  const r = parsePsOutput('  42     1   10 /usr/bin/evren --stdio --workspace /w x\nbozuk\n', 100_000);
  assert.deepEqual(r, [{ pid: 42, ppid: 1, startedAt: 90_000, commandLine: '/usr/bin/evren --stdio --workspace /w x' }]);
});

test('scanAgentLogs etiket/deneme, son satır, aktiflik ve sıralama', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evren logs '));
  try {
    const dir = path.join(root, 'reports', 'agent-logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'api-fix-a1.log'), 'başla\n\x1b[32madım 3\x1b[0m\r\n\n');
    fs.writeFileSync(path.join(dir, 'ui-a2.log'), 'tek');
    fs.writeFileSync(path.join(dir, 'notlar.txt'), 'x');
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(path.join(dir, 'ui-a2.log'), old, old);
    const logs = scanAgentLogs([root, path.join(root, 'yok')]);
    assert.deepEqual(logs.map((l) => [l.label, l.attempt, l.lastLine, l.active]), [
      ['api-fix', 1, 'adım 3', true],
      ['ui', 2, 'tek', false],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lastLine büyük dosyanın yalnız sonunu okur', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evren-ll-')), 'x.log');
  fs.writeFileSync(f, 'a\n'.repeat(100_000) + 'son satır\n');
  assert.equal(lastLine(f, fs.statSync(f).size), 'son satır');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('formatDuration', () => {
  assert.equal(formatDuration(5_400), '5 sn');
  assert.equal(formatDuration(192_000), '3 dk 12 sn');
  assert.equal(formatDuration(3_720_000), '1 sa 2 dk');
});
