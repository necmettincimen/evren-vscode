// Sohbet webview'i. Dosyaya erişmez; her şey eklentiye postMessage ile gider.

interface VsApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsApi;

(() => {
  const vscode = acquireVsCodeApi();
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const log = $<HTMLElement>('log');
  const input = $<HTMLTextAreaElement>('input');
  const sendBtn = $<HTMLButtonElement>('send');
  const stopBtn = $<HTMLButtonElement>('stop');
  const modeSel = $<HTMLSelectElement>('mode');
  const modelBtn = $<HTMLButtonElement>('model');
  const statusEl = $<HTMLElement>('status');
  const banner = $<HTMLElement>('banner');
  const todosEl = $<HTMLElement>('todos');

  let busy = false;
  let ready = false;
  // Akan yanıtın yazıldığı balon ve ham metni.
  let assistantEl: HTMLElement | undefined;
  let assistantText = '';
  let reasoningEl: HTMLElement | undefined;
  let renderQueued = false;
  const toolCards = new Map<string, HTMLElement>();
  const proposals = new Map<string, string>(); // request_id → path

  // ---------- yardımcılar ----------

  function el(tag: string, cls?: string, text?: string): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }

  function inline(s: string): string {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }

  /** Küçük markdown: kod blokları, başlıklar, listeler, satır içi kod/kalın. HTML her zaman kaçırılır. */
  function markdown(src: string): string {
    const out: string[] = [];
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    let list: 'ul' | 'ol' | '' = '';
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = '';
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```(\S*)/);
      if (fence) {
        closeList();
        const body: string[] = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        const lang = fence[1] ? `<span class="lang">${escapeHtml(fence[1])}</span>` : '';
        out.push(`<pre class="code">${lang}<code>${escapeHtml(body.join('\n'))}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const ul = line.match(/^\s*[-*]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (h) {
        closeList();
        out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
      } else if (ul || ol) {
        const kind = ul ? 'ul' : 'ol';
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
      i++;
    }
    closeList();
    return out.join('');
  }

  function scroll(): void {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function add(node: HTMLElement): HTMLElement {
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function endStream(): void {
    assistantEl = undefined;
    assistantText = '';
    reasoningEl = undefined;
  }

  function shortArgs(args: unknown): string {
    if (!args || typeof args !== 'object') return '';
    const a = args as Record<string, unknown>;
    const v = a.path ?? a.file_path ?? a.command ?? a.pattern ?? a.query ?? a.url ?? Object.values(a)[0];
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  function setBusy(b: boolean): void {
    busy = b;
    stopBtn.hidden = !b;
    sendBtn.disabled = b || !ready;
  }

  function disableCard(card: Element, note: string): void {
    card.querySelectorAll('button, input').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('done');
    const n = card.querySelector('.note');
    if (n) n.textContent = note;
  }

  // ---------- olay işleme ----------

  function onEvent(ev: Record<string, any>): void {
    switch (ev.type) {
      case 'turn_start':
        setBusy(true);
        endStream();
        break;
      case 'reasoning_delta': {
        if (!reasoningEl) {
          const d = el('details', 'reasoning');
          d.appendChild(el('summary', '', 'Düşünme'));
          reasoningEl = d.appendChild(el('div', 'body'));
          add(d);
          assistantEl = undefined;
          assistantText = '';
        }
        reasoningEl.textContent += ev.text;
        scroll();
        break;
      }
      case 'assistant_delta':
        if (!assistantEl) {
          assistantEl = add(el('div', 'msg assistant'));
          assistantText = '';
          reasoningEl = undefined;
        }
        assistantText += ev.text;
        if (!renderQueued) {
          renderQueued = true;
          requestAnimationFrame(() => {
            renderQueued = false;
            if (assistantEl) assistantEl.innerHTML = markdown(assistantText);
            scroll();
          });
        }
        break;
      case 'tool_call': {
        endStream();
        const card = el('details', 'tool running');
        const sum = el('summary');
        sum.appendChild(el('span', 'state', '⏳'));
        sum.appendChild(el('span', 'name', ev.name));
        sum.appendChild(el('span', 'arg', shortArgs(ev.args)));
        card.appendChild(sum);
        card.appendChild(el('pre', 'args', JSON.stringify(ev.args, null, 2)));
        toolCards.set(ev.call_id, add(card));
        break;
      }
      case 'tool_result': {
        const card = toolCards.get(ev.call_id);
        if (!card) break;
        card.classList.remove('running');
        card.classList.add(ev.ok ? 'ok' : 'fail');
        card.querySelector('.state')!.textContent = ev.ok ? '✓' : '✗';
        const out = el('pre', 'result', ev.summary + (ev.output_truncated ? '\n… (kırpıldı)' : ''));
        card.appendChild(out);
        break;
      }
      case 'file_change_proposed':
        endStream();
        proposals.set(ev.request_id, ev.path);
        break;
      case 'approval_request':
        endStream();
        approvalCard(ev);
        break;
      case 'ask_user':
        endStream();
        askCard(ev);
        break;
      case 'todos':
        renderTodos(ev.items || []);
        break;
      case 'turn_end': {
        endStream();
        setBusy(false);
        const files: string[] = ev.changed_files || [];
        const cls = ev.exit_code === 0 ? 'turn-end' : 'turn-end fail';
        const text = (ev.exit_code === 0 ? 'Tur bitti' : 'Tur hata/iptal ile bitti') + (files.length ? ` · ${files.length} dosya değişti: ${files.join(', ')}` : '');
        add(el('div', cls, text));
        break;
      }
      case 'error':
        add(el('div', 'error', `${ev.code}: ${ev.message}`));
        break;
      case 'session_loaded':
        log.textContent = '';
        toolCards.clear();
        endStream();
        renderTodos([]);
        for (const m of ev.messages || []) {
          const d = add(el('div', `msg ${m.role === 'user' ? 'user' : 'assistant'}`));
          if (m.role === 'user') d.textContent = m.text;
          else d.innerHTML = markdown(m.text || '');
        }
        add(el('div', 'turn-end', ev.session_id ? `Oturum yüklendi: ${ev.session_id}` : 'Yeni oturum'));
        break;
    }
  }

  function approvalCard(ev: Record<string, any>): void {
    const card = el('div', `card approval kind-${ev.kind}`);
    card.dataset.request = ev.request_id;
    card.appendChild(el('div', 'title', ev.title || 'Onay gerekiyor'));
    if (ev.detail) card.appendChild(el('pre', 'detail', ev.detail));
    const row = el('div', 'row');
    if (proposals.has(ev.request_id)) {
      const show = el('button', 'secondary', 'Diff\'i göster') as HTMLButtonElement;
      show.onclick = () => vscode.postMessage({ type: 'showDiff', request_id: ev.request_id });
      row.appendChild(show);
      card.appendChild(el('div', 'hint', `${proposals.get(ev.request_id)} — sağ tarafı düzenleyip kabul edebilirsiniz.`));
    }
    const labels: [string, string, string][] = [
      ['allow', ev.kind === 'edit' ? 'Kabul' : 'İzin ver', ''],
      ['deny', 'Reddet', 'secondary'],
      ['always', 'Her zaman izin ver', 'secondary'],
    ];
    for (const [decision, label, cls] of labels) {
      const b = el('button', cls, label) as HTMLButtonElement;
      b.onclick = () => {
        disableCard(card, 'gönderiliyor…');
        vscode.postMessage({ type: 'approval', request_id: ev.request_id, decision });
      };
      row.appendChild(b);
    }
    card.appendChild(row);
    card.appendChild(el('div', 'note'));
    add(card);
  }

  function askCard(ev: Record<string, any>): void {
    const card = el('div', 'card ask');
    card.dataset.request = ev.request_id;
    card.appendChild(el('div', 'title', ev.question));
    const answer = (a: string) => {
      if (!a.trim()) return;
      disableCard(card, `Yanıt: ${a}`);
      vscode.postMessage({ type: 'askAnswer', request_id: ev.request_id, answer: a });
    };
    const row = el('div', 'row');
    for (const opt of (ev.options as string[]) || []) {
      const b = el('button', 'secondary', opt) as HTMLButtonElement;
      b.onclick = () => answer(opt);
      row.appendChild(b);
    }
    const free = el('input') as HTMLInputElement;
    free.placeholder = 'Yanıt yaz, Enter';
    free.onkeydown = (e) => {
      if (e.key === 'Enter') answer(free.value);
    };
    row.appendChild(free);
    card.appendChild(row);
    card.appendChild(el('div', 'note'));
    add(card);
    free.focus();
  }

  function renderTodos(items: { content: string; status: string }[]): void {
    todosEl.textContent = '';
    todosEl.hidden = !items.length;
    if (!items.length) return;
    const icon: Record<string, string> = { completed: '☑', in_progress: '◐', pending: '☐' };
    const done = items.filter((t) => t.status === 'completed').length;
    const d = el('details') as HTMLDetailsElement;
    d.open = true;
    d.appendChild(el('summary', '', `Yapılacaklar ${done}/${items.length}`));
    const ul = el('ul');
    for (const t of items) {
      ul.appendChild(el('li', `todo ${t.status}`, `${icon[t.status] ?? '•'} ${t.content}`));
    }
    d.appendChild(ul);
    todosEl.appendChild(d);
  }

  function onStatus(s: Record<string, any>): void {
    ready = s.state === 'ready';
    setBusy(!!s.busy);
    modeSel.value = s.mode;
    modelBtn.textContent = s.model || 'model';
    const tok = s.tokens ? ` · ${s.tokens >= 1000 ? (s.tokens / 1000).toFixed(1) + 'k' : s.tokens} tok` : '';
    const label: Record<string, string> = { starting: 'başlatılıyor…', ready: 'hazır', crashed: 'kapandı', error: 'hata', stopped: 'durdu' };
    statusEl.textContent = `${label[s.state] ?? s.state}${s.version ? ' · v' + s.version : ''}${tok}`;
    banner.textContent = '';
    banner.hidden = !(s.state === 'crashed' || s.state === 'error');
    if (!banner.hidden) {
      banner.appendChild(el('span', '', s.message || 'Evren CLI çalışmıyor.'));
      const r = el('button', '', 'Yeniden başlat') as HTMLButtonElement;
      r.onclick = () => vscode.postMessage({ type: 'restart' });
      const l = el('button', 'secondary', 'Loglar') as HTMLButtonElement;
      l.onclick = () => vscode.postMessage({ type: 'showLogs' });
      banner.append(r, l);
    }
  }

  // ---------- eklentiden gelen mesajlar ----------

  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'event':
        if (m.ev && typeof m.ev.type === 'string') onEvent(m.ev);
        break;
      case 'status':
        onStatus(m);
        break;
      case 'userMessage': {
        endStream();
        const d = add(el('div', 'msg user', m.text));
        if (Array.isArray(m.attachments) && m.attachments.length) d.appendChild(el('div', 'att', '📎 ' + m.attachments.join(', ')));
        break;
      }
      case 'insert': {
        const pos = input.selectionStart ?? input.value.length;
        const needsSpace = pos > 0 && !/\s$/.test(input.value.slice(0, pos));
        input.setRangeText((needsSpace ? ' ' : '') + String(m.text), pos, input.selectionEnd ?? pos, 'end');
        input.focus();
        break;
      }
      case 'approvalDone': {
        const card = log.querySelector(`.approval[data-request="${CSS.escape(m.request_id)}"]`);
        if (card) disableCard(card, m.decision === 'deny' ? 'Reddedildi' : m.edited ? 'Düzenlenmiş içerikle kabul edildi' : m.decision === 'always' ? 'Her zaman izinli' : 'Kabul edildi');
        break;
      }
      case 'pendingCleared':
        log.querySelectorAll('.card:not(.done)').forEach((c) => disableCard(c, 'Geçersiz (tur bitti)'));
        break;
    }
  });

  // ---------- kullanıcı girişleri ----------

  function send(): void {
    const text = input.value;
    if (!text.trim() || busy || !ready) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  }

  sendBtn.onclick = send;
  stopBtn.onclick = () => vscode.postMessage({ type: 'cancel' });
  $<HTMLButtonElement>('attach').onclick = () => vscode.postMessage({ type: 'pickFile' });
  $<HTMLButtonElement>('history').onclick = () => vscode.postMessage({ type: 'history' });
  $<HTMLButtonElement>('new').onclick = () => vscode.postMessage({ type: 'newSession' });
  modelBtn.onclick = () => vscode.postMessage({ type: 'pickModel' });
  modeSel.onchange = () => vscode.postMessage({ type: 'setMode', mode: modeSel.value });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && busy) {
      vscode.postMessage({ type: 'cancel' });
    }
  });
  input.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    if (ie.data === '@') {
      const pos = input.selectionStart ?? 0;
      const before = input.value.slice(0, pos - 1);
      if (!before || /\s$/.test(before)) {
        input.setRangeText('', pos - 1, pos, 'end');
        vscode.postMessage({ type: 'pickFile' });
      }
    }
  });

  setBusy(false);
  vscode.postMessage({ type: 'ready' });
})();
