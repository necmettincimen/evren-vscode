// Extension Host içinde çalışır: gerçek `evren --stdio` ile senaryoları sırayla koşar.
// EVREN_E2E_ONLY=ad1,ad2 yalnız seçilen senaryoları çalıştırır.

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatViewProvider } from '../../chat/ChatViewProvider';
import type { EvrenProcess } from '../../cli/EvrenProcess';
import type { Decision, EvrenEvent, EventOf } from '../../cli/protocol';

const MARK = '<!-- elle düzenlendi -->';

type ApprovalEv = EventOf<'approval_request'>;

interface Ctx {
  ws: string;
  chat: ChatViewProvider;
  proc: EvrenProcess;
}

interface TurnOptions {
  /** Onay isteğine verilecek karar; varsayılan allow. */
  onApproval?: (ev: ApprovalEv, turn: Turn) => Promise<Decision> | Decision;
  onEvent?: (ev: EvrenEvent, turn: Turn) => void;
  timeoutMs?: number;
}

interface Turn {
  events: EvrenEvent[];
  proposals: EventOf<'file_change_proposed'>[];
  approvals: { ev: ApprovalEv; decision: Decision }[];
  end?: EventOf<'turn_end'>;
}

function waitFor<T>(fn: () => T | undefined, ms: number, what: string): Promise<T> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`zaman aşımı: ${what}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function diffTab(): vscode.TabInputTextDiff | undefined {
  for (const t of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    if (t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === 'evren-orig') {
      return t.input;
    }
  }
  return undefined;
}

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

/** Sohbet üzerinden bir istek gönderir, turn_end'e kadar olayları toplar. */
async function runTurn(ctx: Ctx, text: string, opts: TurnOptions = {}): Promise<Turn> {
  const turn: Turn = { events: [], proposals: [], approvals: [] };
  let sub: vscode.Disposable | undefined;
  const done = new Promise<void>((resolve, reject) => {
    sub = ctx.chat.events.event(async (ev) => {
      turn.events.push(ev);
      try {
        opts.onEvent?.(ev, turn);
        switch (ev.type) {
          case 'tool_call':
            log(`  tool_call ${ev.name}`);
            break;
          case 'tool_result':
            if (!ev.ok) log(`  tool_result HATA ${ev.name}: ${ev.summary.slice(0, 160)}`);
            break;
          case 'file_change_proposed':
            turn.proposals.push(ev);
            break;
          case 'approval_request': {
            const decision = opts.onApproval ? await opts.onApproval(ev, turn) : 'allow';
            log(`  approval ${ev.kind} → ${decision}: ${(ev.detail || ev.title).split('\n')[0].slice(0, 100)}`);
            turn.approvals.push({ ev, decision });
            await ctx.chat.answerApproval(ev.request_id, decision);
            break;
          }
          case 'ask_user':
            log(`  ask_user: ${ev.question}`);
            ctx.proc.send({ type: 'ask_user_response', request_id: ev.request_id, answer: ev.options?.[0] ?? 'evet, devam et' });
            break;
          case 'error':
            log(`  error ${ev.code}: ${ev.message}`);
            break;
          case 'turn_end':
            turn.end = ev;
            resolve();
            break;
        }
      } catch (err) {
        reject(err);
      }
    });
  });
  const ms = opts.timeoutMs ?? 300_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    await ctx.chat.sendPrompt(text);
    await Promise.race([
      done,
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`tur ${ms / 1000} sn içinde bitmedi`)), ms))),
    ]);
  } finally {
    clearTimeout(timer);
    sub?.dispose();
  }
  log(`  turn_end exit=${turn.end!.exit_code} changed=${JSON.stringify(turn.end!.changed_files)}`);
  return turn;
}

async function fresh(ctx: Ctx): Promise<void> {
  const loaded = await ctx.proc.request({ type: 'new_session' }, 'session_loaded');
  assert.equal(loaded.session_id, null);
}

function read(ctx: Ctx, rel: string): string {
  return fs.readFileSync(path.join(ctx.ws, rel), 'utf8');
}

// ---------------------------------------------------------------- senaryolar

const scenarios: Record<string, (ctx: Ctx) => Promise<void>> = {
  /** Kip ve model komutları, hatalı değerler. */
  async ayarlar(ctx) {
    const models = await ctx.proc.request({ type: 'list_models' }, 'models');
    assert.ok(models.models.includes(models.current), 'current listede yok');
    const changed = await ctx.proc.request({ type: 'set_model', model: models.current }, 'model_changed');
    assert.equal(changed.model, models.current);

    await ctx.chat.setMode('plan');
    await waitFor(() => (ctx.chat as unknown as { mode: string }).mode === 'plan' || undefined, 5000, 'mode plan');
    await ctx.chat.setMode('normal');
    await waitFor(() => (ctx.chat as unknown as { mode: string }).mode === 'normal' || undefined, 5000, 'mode normal');

    await assert.rejects(
      ctx.proc.request({ type: 'set_mode', mode: 'yolo' as never }, 'mode_changed'),
      (e: { code: string }) => e.code === 'invalid_mode',
    );
    await assert.rejects(
      ctx.proc.request({ type: 'resume', session_id: 'yok-boyle-oturum' }, 'session_loaded'),
      (e: { code: string }) => e.code === 'unknown_session',
    );
    await assert.rejects(
      ctx.proc.request({ type: 'slash', command: 'exit' }, 'sessions'),
      (e: { code: string }) => e.code === 'unsupported_slash',
    );
  },

  /** Düzenleme önerisi diff'te açılır, sağ taraf elle düzenlenir, düzenlenen içerik yazılır. */
  async duzenleme(ctx) {
    await fresh(ctx);
    let edited = false;
    const turn = await runTurn(ctx, "README.md dosyasının en sonuna 'Merhaba Evren' satırını ekle. edit_file kullan, başka hiçbir şey yapma.", {
      async onApproval(ev): Promise<Decision> {
        if (ev.kind === 'edit' && !edited) {
          const input = await waitFor(diffTab, 10_000, 'diff sekmesi');
          const doc = await vscode.workspace.openTextDocument(input.modified);
          const we = new vscode.WorkspaceEdit();
          const end = doc.lineAt(doc.lineCount - 1).range.end;
          we.insert(doc.uri, end, (doc.getText().endsWith('\n') ? '' : '\n') + MARK + '\n');
          await vscode.workspace.applyEdit(we);
          edited = true;
        }
        return 'allow';
      },
    });
    const readme = read(ctx, 'README.md');
    assert.equal(turn.end!.exit_code, 0, 'tur başarısız');
    assert.ok(turn.proposals.length > 0, 'file_change_proposed gelmedi');
    assert.ok(turn.events.some((e) => e.type === 'usage'), 'usage gelmedi');
    assert.ok(edited, 'diff düzenlenmedi');
    assert.ok(readme.includes('Merhaba Evren'), 'satır eklenmedi');
    assert.ok(readme.includes(MARK), 'edited_content diske yazılmadı');
    assert.ok(turn.end!.changed_files.includes('README.md'), 'changed_files README içermiyor');
    assert.equal(diffTab(), undefined, 'diff sekmesi kapanmadı');
  },

  /** Bütün onaylar reddedilir: dosya değişmemeli, diff kapanmalı. */
  async reddet(ctx) {
    await fresh(ctx);
    const before = read(ctx, 'README.md');
    const turn = await runTurn(ctx, "README.md dosyasının en sonuna 'REDDEDILECEK' satırını ekle. Onay verilmezse tekrar deneme, dur.", {
      onApproval: (): Decision => 'deny',
      timeoutMs: 180_000,
    });
    assert.ok(turn.approvals.length > 0, 'hiç onay istenmedi');
    assert.equal(read(ctx, 'README.md'), before, 'reddedilen değişiklik yazıldı');
    assert.ok(!turn.end!.changed_files.includes('README.md'), 'changed_files README içeriyor');
    assert.equal(diffTab(), undefined, 'diff sekmesi kapanmadı');
    const results = turn.events.filter((e): e is EventOf<'tool_result'> => e.type === 'tool_result');
    assert.ok(results.some((r) => /İPTAL|onaylamadı|reddet/i.test(r.summary)), 'ret sonucu modele iletilmedi');
  },

  /** Tur ortasında iptal: turn_end gelmeli, ardından yeni tur başlatılabilmeli. */
  async iptal(ctx) {
    await fresh(ctx);
    let cancelledAt = 0;
    const turn = await runTurn(ctx, 'Bu depodaki her dosyayı tek tek oku ve her biri için ayrıntılı birer paragraf özet yaz, sonra hepsini birleştir.', {
      onEvent(ev) {
        if (!cancelledAt && (ev.type === 'tool_call' || ev.type === 'assistant_delta' || ev.type === 'reasoning_delta')) {
          cancelledAt = Date.now();
          log('  cancel gönderildi');
          ctx.chat.cancel();
        }
      },
      onApproval: (): Decision => 'deny',
      timeoutMs: 120_000,
    });
    assert.ok(cancelledAt, 'iptal edilecek olay gelmedi');
    const waited = Date.now() - cancelledAt;
    log(`  iptalden turn_end'e ${waited} ms`);
    assert.ok(waited < 60_000, 'iptal 60 sn içinde sonuçlanmadı');
    assert.ok(turn.end, 'turn_end yok');
    // İptalden sonra süreç meşgul kalmamalı.
    const next = await runTurn(ctx, "Yalnız 'tamam' yaz, araç kullanma.", { timeoutMs: 120_000 });
    assert.equal(next.end!.exit_code, 0, 'iptal sonrası tur başarısız');
  },

  /** Sıfırdan küçük bir uygulama: dosyalar oluşturulur, testleri hem ajan hem biz çalıştırırız. */
  async uygulama(ctx) {
    await fresh(ctx);
    let first = true;
    const turn = await runTurn(
      ctx,
      [
        'app/ klasöründe Python standart kütüphanesiyle (dış bağımlılık yok) bir yapılacaklar CLI uygulaması oluştur:',
        '- app/todo.py: `python app/todo.py add "metin"`, `list`, `done <no>` komutları; veriyi app/todos.json içinde saklar,',
        '  dosya yolu TODO_FILE ortam değişkeniyle değiştirilebilir. Mantık add_item/list_items/complete_item fonksiyonlarında olsun.',
        '- app/test_todo.py: unittest ile en az 4 test (ekle, listele, tamamla, geçersiz numara). Testler geçici dosya kullansın.',
        'Sonra `python -m unittest discover -s app -v` ile testleri çalıştır ve geçene kadar düzelt.',
      ].join('\n'),
      {
        onApproval(ev): Decision {
          // İlk komut onayı "always": kural settings.local.json'a yazılmalı.
          if (ev.kind === 'command' && first) {
            first = false;
            return 'always';
          }
          return 'allow';
        },
        timeoutMs: 600_000,
      },
    );
    assert.equal(turn.end!.exit_code, 0, 'tur başarısız');
    for (const f of ['app/todo.py', 'app/test_todo.py']) {
      assert.ok(fs.existsSync(path.join(ctx.ws, f)), `${f} oluşturulmadı`);
    }
    const created = turn.proposals.filter((p) => p.old_content === '');
    log(`  yeni dosya önerileri: ${created.map((p) => p.path).join(', ')}`);
    assert.ok(created.length >= 2, 'yeni dosyalar için file_change_proposed gelmedi');
    assert.ok(turn.events.some((e) => e.type === 'tool_call' && e.name === 'run_command'), 'ajan testleri çalıştırmadı');

    const test = cp.spawnSync('python', ['-m', 'unittest', 'discover', '-s', 'app', '-v'], {
      cwd: ctx.ws, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    log(`  bizim test koşumuz: kod ${test.status}\n${(test.stderr || '').split('\n').slice(-6).join('\n')}`);
    assert.equal(test.status, 0, 'uygulamanın testleri geçmiyor');
    const ran = /Ran (\d+) test/.exec(test.stderr || '');
    assert.ok(ran && Number(ran[1]) >= 4, `en az 4 test bekleniyordu: ${ran?.[1]}`);

    const tmp = path.join(ctx.ws, 'e2e-todos.json');
    const env = { ...process.env, TODO_FILE: tmp, PYTHONIOENCODING: 'utf-8' };
    const run = (...a: string[]) => cp.spawnSync('python', ['app/todo.py', ...a], { cwd: ctx.ws, encoding: 'utf8', env, timeout: 30_000 });
    assert.equal(run('add', 'süt al').status, 0, 'add çalışmadı');
    const listed = run('list');
    assert.ok(listed.stdout.includes('süt al'), `list çıktısında madde yok: ${listed.stdout}`);
    assert.equal(run('done', '1').status, 0, 'done çalışmadı');
    assert.ok(fs.existsSync(tmp), 'TODO_FILE dikkate alınmadı');

    if (!first) {
      const rules = path.join(ctx.ws, '.evren', 'settings.local.json');
      assert.ok(fs.existsSync(rules), '"always" kuralı yazılmadı');
      log(`  always kuralı: ${fs.readFileSync(rules, 'utf8').replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  },

  /** Geçmiş: oturumlar listelenir ve biri yüklenir. */
  async oturumlar(ctx) {
    const sessions = await ctx.proc.request({ type: 'list_sessions' }, 'sessions');
    log(`  oturum sayısı: ${sessions.items.length}`);
    assert.ok(sessions.items.length > 0, 'kayıtlı oturum yok');
    const loaded = await ctx.proc.request({ type: 'resume', session_id: sessions.items[0].session_id }, 'session_loaded');
    assert.ok(loaded.messages.length > 0, 'resume boş döndü');
    assert.ok(loaded.messages.some((m) => m.role === 'user'), 'kullanıcı mesajı yok');
  },
};

export async function run(): Promise<void> {
  const ws = process.env.EVREN_E2E_WS!;
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'evren-vscode')!;
  const { chat } = (await ext.activate()) as { chat: ChatViewProvider };
  await vscode.commands.executeCommand('evren.openChat');
  await chat.start();
  const proc = await waitFor(() => (chat.process?.ready ? chat.process : undefined), 60_000, 'ready');
  log(`hazır: evren ${proc.ready!.version}, model ${proc.ready!.model}, ${ws}`);
  const ctx: Ctx = { ws, chat, proc };

  const only = (process.env.EVREN_E2E_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const results: { name: string; ok: boolean; ms: number; err?: string }[] = [];
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only.length && !only.includes(name)) continue;
    log(`▶ ${name}`);
    const t0 = Date.now();
    try {
      await fn(ctx);
      results.push({ name, ok: true, ms: Date.now() - t0 });
      log(`✔ ${name}`);
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - t0, err: (err as Error).message });
      log(`✖ ${name}: ${(err as Error).message}`);
      if (!chat.process?.running) {
        log('  süreç düştü, yeniden başlatılıyor');
        await chat.restart();
        ctx.proc = await waitFor(() => (chat.process?.ready ? chat.process : undefined), 60_000, 'ready');
      }
    }
  }
  log('ÖZET');
  for (const r of results) {
    log(`  ${r.ok ? '✔' : '✖'} ${r.name} (${(r.ms / 1000).toFixed(1)} sn)${r.err ? ' — ' + r.err : ''}`);
  }
  await ctx.proc.stop();
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(`${failed.length} senaryo başarısız: ${failed.map((f) => f.name).join(', ')}`);
  }
}
