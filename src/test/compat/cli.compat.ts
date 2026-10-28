// LLM gerektirmeyen uyumluluk testi: gerçek `evren --stdio` + evren-cli'nin sahte model sunucusu.
// Ortam: EVREN_BASE_URL (scripts/fake_llm_server.py adresi), isteğe bağlı EVREN_CLI (varsayılan `evren`).
// CI, evren-cli'yi protocol/CLI_TAG sürümünden kurar. Kullanım: npm run test:compat

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvrenProcess, ProtocolError, buildLaunch } from '../../cli/EvrenProcess';
import { EvrenEvent, MIN_CLI_VERSION, versionAtLeast } from '../../cli/protocol';

const baseUrl = process.env.EVREN_BASE_URL;
const skip = baseUrl ? false : 'EVREN_BASE_URL yok (sahte model sunucusu başlatılmadı)';

function start(ws: string): EvrenProcess {
  const spec = buildLaunch({
    cliPath: process.env.EVREN_CLI || 'evren',
    workspace: ws,
    extraEnv: {
      EVREN_API_KEY: 'fake-key',
      EVREN_BASE_URL: baseUrl ?? '',
      EVREN_DEFAULT_MODEL: 'fake-model',
      EVREN_CLI_HOME: path.join(ws, '.home'),
      EVREN_AUTO_APPROVE: 'false',
      EVREN_AUTO_DOCS: 'false',
      EVREN_AUTO_ROUTE: 'false',
      EVREN_CLEF_INTENT: 'false',
      EVREN_SEMANTIC_SEARCH: 'false',
      PYTHONIOENCODING: 'utf-8',
    },
  });
  return new EvrenProcess(spec, { readyTimeoutMs: 60000, requestTimeoutMs: 30000 });
}

async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof ProtocolError && err.code === code);
}

test('ayar komutları ve hata kodları', { skip }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'evren-compat-'));
  const proc = start(ws);
  try {
    const ready = await proc.start();
    assert.ok(versionAtLeast(ready.version, MIN_CLI_VERSION), `CLI ${ready.version} < ${MIN_CLI_VERSION}`);
    const models = await proc.request({ type: 'list_models' }, 'models');
    assert.ok(models.models.includes('fake-model'));
    assert.equal((await proc.request({ type: 'set_mode', mode: 'plan' }, 'mode_changed')).mode, 'plan');
    assert.equal((await proc.request({ type: 'set_mode', mode: 'normal' }, 'mode_changed')).mode, 'normal');
    assert.equal((await proc.request({ type: 'set_model', model: 'fake-model-2' }, 'model_changed')).model, 'fake-model-2');
    assert.ok(Array.isArray((await proc.request({ type: 'list_sessions' }, 'sessions')).items));
    await expectError(proc.request({ type: 'set_model', model: '' }, 'model_changed'), 'invalid_model');
    await expectError(proc.request({ type: 'resume', session_id: 'yok' }, 'session_loaded'), 'unknown_session');
    await expectError(proc.request({ type: 'slash', command: 'exit' }, 'turn_end'), 'unsupported_slash');
  } finally {
    await proc.stop();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('onaylı dosya yazımı turu', { skip }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'evren-compat-'));
  const proc = start(ws);
  try {
    await proc.start();
    const events: EvrenEvent[] = [];
    const done = new Promise<EvrenEvent>((resolve) => {
      proc.on('event', (ev: EvrenEvent) => {
        events.push(ev);
        if (ev.type === 'approval_request') {
          proc.send({ type: 'approval_response', request_id: ev.request_id, decision: 'allow' });
        }
        if (ev.type === 'turn_end') {
          resolve(ev);
        }
      });
    });
    proc.send({ type: 'prompt', text: 'dosya: notlar.txt' });
    const end = await done;
    assert.equal(end.type === 'turn_end' && end.exit_code, 0);
    assert.ok(events.some((e) => e.type === 'file_change_proposed'));
    assert.ok(events.some((e) => e.type === 'tool_result' && e.ok));
    assert.equal(fs.readFileSync(path.join(ws, 'notlar.txt'), 'utf8'), 'sahte model içeriği\n');
  } finally {
    await proc.stop();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
