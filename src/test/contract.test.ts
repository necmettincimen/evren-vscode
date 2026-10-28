// Sözleşme testi: protocol.ts, evren-cli'nin protocol/stdio-v1.schema.json şemasıyla tutarlı mı?
// Şema yolu: EVREN_SCHEMA ya da depodaki protocol/stdio-v1.schema.json (CI bunu CLI_TAG'den indirir).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import {
  COMMAND_TYPES, Command, EVENT_TYPES, MIN_CLI_VERSION, PROTOCOL_VERSION, encodeCommand, versionAtLeast,
} from '../cli/protocol';

const schemaPath = process.env.EVREN_SCHEMA || path.resolve(__dirname, '../../protocol/stdio-v1.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema, 'stdio');
const validateCommand = ajv.getSchema('stdio#/$defs/command')!;
const validateEvent = ajv.getSchema('stdio#/$defs/event')!;

function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

test('protokol sürümü ve en düşük CLI sürümü şemayla uyumlu', () => {
  assert.equal(PROTOCOL_VERSION, schema['x-protocol-version']);
  assert.ok(versionAtLeast(MIN_CLI_VERSION, schema['x-min-cli-version']),
    `MIN_CLI_VERSION ${MIN_CLI_VERSION} < şema ${schema['x-min-cli-version']}`);
});

test('komut ve olay listeleri şemayla aynı', () => {
  assert.deepEqual(sorted(COMMAND_TYPES), sorted(schema['x-command-types']));
  assert.deepEqual(sorted(EVENT_TYPES), sorted(schema['x-event-types']));
});

test('eklentinin ürettiği her komut şemaya uyar', () => {
  const samples: Command[] = [
    { type: 'prompt', text: 'merhaba', mode: 'plan', attachments: [{ path: 'a.ts', range: { start: 1, end: 3 } }] },
    { type: 'cancel' },
    { type: 'approval_response', request_id: 'r1', decision: 'always', edited_content: 'x' },
    { type: 'ask_user_response', request_id: 'r2', answer: 'evet' },
    { type: 'set_model', model: 'm' },
    { type: 'set_mode', mode: 'ask' },
    { type: 'list_sessions', limit: 5 },
    { type: 'resume', session_id: 's' },
    { type: 'new_session' },
    { type: 'list_models' },
    { type: 'quota' },
    { type: 'slash', command: 'model', args: 'm' },
  ];
  assert.deepEqual(sorted(samples.map((s) => s.type)), sorted(COMMAND_TYPES), 'her komut için örnek olmalı');
  for (const cmd of samples) {
    const msg = JSON.parse(encodeCommand(cmd, 'c1'));
    assert.ok(validateCommand(msg), `${cmd.type}: ${ajv.errorsText(validateCommand.errors)}`);
  }
});

test('örnek olaylar şemaya uyar, hatalı olay reddedilir', () => {
  const ok = [
    { v: 1, type: 'ready', id: 's1', version: '3.10.0', model: 'm', workspace: '/w', protocol: 1 },
    { v: 1, type: 'turn_end', id: 's2', reply_to: 'p1', result: 'ok', changed_files: [], exit_code: 0 },
    { v: 1, type: 'error', id: 's3', message: 'x', code: 'busy' },
  ];
  for (const ev of ok) {
    assert.ok(validateEvent(ev), `${ev.type}: ${ajv.errorsText(validateEvent.errors)}`);
  }
  assert.equal(validateEvent({ v: 1, type: 'error', id: 's4', message: 'x', code: 'uydurma' }), false);
  assert.equal(validateEvent({ v: 1, type: 'ready', id: 's5' }), false);
});
