// Sohbet webview'i. Dosyaya erişmez; her şey eklentiye postMessage ile gider.
// Her sekme ayrı bir CLI sürecidir; olaylar `sid` ile hangi sekmeye ait olduğunu taşır.

interface VsApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsApi;

interface TabInfo {
  id: string;
  title: string;
  state: string;
  busy: boolean;
  waiting: boolean;
}

interface HistoryEntry {
  session_id: string;
  title: string;
  model: string;
  mode: string;
  at: string;
  messages: number;
  open: boolean;
}

/** Bir sohbet sekmesinin tarayıcıdaki durumu. */
interface Tab {
  id: string;
  info: TabInfo;
  logEl: HTMLElement;
  assistantEl?: HTMLElement;
  assistantText: string;
  reasoningEl?: HTMLElement;
  renderQueued: boolean;
  toolCards: Map<string, HTMLElement>;
  proposals: Map<string, string>; // request_id → path
  todos: { content: string; status: string }[];
  status: Record<string, any>;
  busy: boolean;
  ready: boolean;
  turnStartedAt: number;
  stage: string;
  waiting: boolean;
  draft: string;
}

(() => {
  const vscode = acquireVsCodeApi();
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const logs = $<HTMLElement>('logs');
  const tablist = $<HTMLElement>('tablist');
  const input = $<HTMLTextAreaElement>('input');
  const sendBtn = $<HTMLButtonElement>('send');
  const stopBtn = $<HTMLButtonElement>('stop');
  const modeSel = $<HTMLSelectElement>('mode');
  const modelBtn = $<HTMLButtonElement>('model');
  const statusEl = $<HTMLElement>('status');
  const banner = $<HTMLElement>('banner');
  const todosEl = $<HTMLElement>('todos');
  const workingEl = $<HTMLElement>('working');
  const stageEl = $<HTMLElement>('stage');
  const elapsedEl = $<HTMLElement>('elapsed');
  const historyEl = $<HTMLElement>('history');
  const histList = $<HTMLElement>('histlist');
  const histFilter = $<HTMLInputElement>('histfilter');

  const tabs = new Map<string, Tab>();
  let cur: Tab | undefined;
  let tick: number | undefined;
  let historyItems: HistoryEntry[] = [];
  /** Mesaj balonlarının ham metni (Kopyala düğmesi için). */
  const raws = new WeakMap<HTMLElement, string>();

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
        out.push(`<div class="codewrap"><button type="button" class="copy" title="Kodu kopyala">Kopyala</button><pre class="code">${lang}<code>${escapeHtml(body.join('\n'))}</code></pre></div>`);
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

  /** Kopyalanabilir `pre`: sağ üstte Kopyala düğmesi (metin seçimine karışmaz). */
  function preWithCopy(cls: string, text: string): HTMLElement {
    const wrap = el('div', 'codewrap');
    const b = el('button', 'copy', 'Kopyala') as HTMLButtonElement;
    b.type = 'button';
    b.title = 'Kopyala';
    wrap.append(b, el('pre', cls, text));
    return wrap;
  }

  /** Mesaj balonu: gövde + Kopyala düğmesi. Gövde yeniden çizilse de düğme kalır. */
  function msgEl(kind: 'user' | 'assistant', text: string, streaming = false): HTMLElement {
    const m = el('div', `msg ${kind}${streaming ? ' streaming' : ''}`);
    const body = el('div', kind === 'assistant' ? 'md' : 'txt');
    if (kind === 'assistant') body.innerHTML = markdown(text);
    else body.textContent = text;
    const c = el('button', 'copy msgcopy', 'Kopyala') as HTMLButtonElement;
    c.type = 'button';
    c.title = 'Mesajı kopyala';
    m.append(body, c);
    raws.set(m, text);
    return m;
  }

  function hasSelectionIn(node: Node | null | undefined): boolean {
    const sel = window.getSelection();
    return !!node && !!sel && !sel.isCollapsed && (node.contains(sel.anchorNode) || node.contains(sel.focusNode));
  }

  // ---------- sekmeler ----------

  function makeTab(info: TabInfo): Tab {
    const logEl = el('main', 'log');
    logEl.hidden = true;
    logs.appendChild(logEl);
    const t: Tab = {
      id: info.id, info, logEl, assistantText: '', renderQueued: false,
      toolCards: new Map(), proposals: new Map(), todos: [], status: {},
      busy: false, ready: false, turnStartedAt: 0, stage: 'Düşünüyor…', waiting: false, draft: '',
    };
    tabs.set(info.id, t);
    return t;
  }

  function tabFor(sid: unknown): Tab | undefined {
    return typeof sid === 'string' ? tabs.get(sid) : undefined;
  }

  function renderTabs(): void {
    tablist.textContent = '';
    for (const t of tabs.values()) {
      const tab = el('div', `tab${t === cur ? ' active' : ''}${t.info.busy ? ' busy' : ''}${t.info.waiting ? ' waiting' : ''}`);
      tab.setAttribute('role', 'tab');
      tab.dataset.sid = t.id;
      tab.title = t.info.title + (t.info.waiting ? ' — yanıtınızı bekliyor' : t.info.busy ? ' — çalışıyor' : '');
      tab.appendChild(el('span', 'dot'));
      tab.appendChild(el('span', 'ttl', t.info.title));
      if (tabs.size > 1) {
        const x = el('button', 'x', '×') as HTMLButtonElement;
        x.title = 'Sekmeyi kapat';
        x.setAttribute('aria-label', 'Sekmeyi kapat');
        tab.appendChild(x);
      }
      tablist.appendChild(tab);
    }
  }

  function applyTabs(infos: TabInfo[], active: string): void {
    const ids = new Set(infos.map((i) => i.id));
    for (const [id, t] of [...tabs]) {
      if (!ids.has(id)) {
        t.logEl.remove();
        tabs.delete(id);
      }
    }
    for (const info of infos) {
      const t = tabs.get(info.id);
      if (t) t.info = info;
      else makeTab(info);
    }
    const next = tabs.get(active) ?? [...tabs.values()][0];
    if (next && next !== cur) switchTo(next);
    else renderTabs();
  }

  function switchTo(t: Tab): void {
    if (cur) {
      cur.draft = input.value;
      cur.logEl.hidden = true;
    }
    cur = t;
    t.logEl.hidden = false;
    input.value = t.draft;
    autosize();
    closeHistory();
    renderTabs();
    renderActive();
    log().scrollTop = log().scrollHeight;
  }

  function log(): HTMLElement {
    return cur!.logEl;
  }

  /** Etkin sekmenin durumunu ortak arayüze (çalışma çubuğu, durum, banner, yapılacaklar) yansıtır. */
  function renderActive(): void {
    const t = cur;
    if (!t) return;
    const s = t.status;
    sendBtn.disabled = t.busy || !t.ready;
    stopBtn.hidden = !t.busy;
    sendBtn.hidden = t.busy;
    workingEl.hidden = !t.busy;
    stageEl.textContent = t.stage;
    workingEl.classList.toggle('waiting', t.waiting);
    clearInterval(tick);
    tick = undefined;
    if (t.busy) {
      updateElapsed();
      tick = window.setInterval(updateElapsed, 1000);
    }
    showMode(s.mode ?? 'normal');
    modelBtn.textContent = s.model || 'model';
    const tok = s.tokens ? ` · ${s.tokens >= 1000 ? (s.tokens / 1000).toFixed(1) + 'k' : s.tokens} tok` : '';
    const label: Record<string, string> = { starting: 'başlatılıyor…', ready: 'hazır', crashed: 'kapandı', error: 'hata', stopped: 'durdu' };
    statusEl.textContent = s.state ? `${label[s.state] ?? s.state}${s.version ? ' · v' + s.version : ''}${tok}` : '';
    banner.textContent = '';
    banner.hidden = !(s.state === 'crashed' || s.state === 'error');
    if (!banner.hidden) {
      banner.appendChild(el('span', '', s.message || 'Evren CLI çalışmıyor.'));
      const r = el('button', '', 'Yeniden başlat') as HTMLButtonElement;
      r.onclick = () => vscode.postMessage({ type: 'restart', sid: t.id });
      const l = el('button', 'secondary', 'Loglar') as HTMLButtonElement;
      l.onclick = () => vscode.postMessage({ type: 'showLogs' });
      banner.append(r, l);
    }
    renderTodos();
  }

  // ---------- akış ----------

  function scroll(t: Tab): void {
    const l = t.logEl;
    if (l.hidden) return;
    const nearBottom = l.scrollHeight - l.scrollTop - l.clientHeight < 120;
    if (nearBottom) l.scrollTop = l.scrollHeight;
  }

  function add(t: Tab, node: HTMLElement): HTMLElement {
    t.logEl.appendChild(node);
    if (!t.logEl.hidden) t.logEl.scrollTop = t.logEl.scrollHeight;
    return node;
  }

  /** Akan yanıtı çizer; kullanıcı o metinden seçim yapıyorsa (kopyalamak için) seçimi bozmamak için atlar. */
  function renderAssistant(t: Tab, final = false): void {
    const m = t.assistantEl;
    if (!m) return;
    raws.set(m, t.assistantText);
    const body = m.querySelector('.md') as HTMLElement;
    if (!final && hasSelectionIn(body)) return;
    body.innerHTML = markdown(t.assistantText);
  }

  function queueRender(t: Tab): void {
    if (t.renderQueued) return;
    t.renderQueued = true;
    requestAnimationFrame(() => {
      t.renderQueued = false;
      const body = t.assistantEl?.querySelector('.md');
      if (body && hasSelectionIn(body)) {
        setTimeout(() => queueRender(t), 500); // seçim bitince son metin çizilir
        return;
      }
      renderAssistant(t);
      scroll(t);
    });
  }

  function endStream(t: Tab): void {
    // Bekleyen kare çizimi balonu kaybetmeden son metni yazsın.
    renderAssistant(t, true);
    t.assistantEl?.classList.remove('streaming');
    t.assistantEl = undefined;
    t.assistantText = '';
    t.reasoningEl = undefined;
  }

  function shortArgs(args: unknown): string {
    if (!args || typeof args !== 'object') return '';
    const a = args as Record<string, unknown>;
    const v = a.path ?? a.file_path ?? a.command ?? a.pattern ?? a.query ?? a.url ?? Object.values(a)[0];
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  function setBusy(t: Tab, b: boolean): void {
    if (b === t.busy) return;
    t.busy = b;
    if (b) {
      if (!t.turnStartedAt) t.turnStartedAt = Date.now();
    } else {
      t.turnStartedAt = 0;
      t.stage = 'Düşünüyor…';
      t.waiting = false;
    }
    if (t === cur) renderActive();
  }

  /** Çalışma çubuğundaki aşama metni; `waiting` kullanıcıdan yanıt beklendiğini gösterir. */
  function setStage(t: Tab, text: string, waiting = false): void {
    t.stage = text;
    t.waiting = waiting;
    if (t === cur) {
      stageEl.textContent = text;
      workingEl.classList.toggle('waiting', waiting);
    }
  }

  function updateElapsed(): void {
    elapsedEl.textContent = cur?.turnStartedAt ? formatElapsed(Date.now() - cur.turnStartedAt) : '';
  }

  function formatElapsed(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} sn` : `${Math.floor(s / 60)} dk ${s % 60} sn`;
  }

  function disableCard(card: Element, note: string): void {
    card.querySelectorAll('button, input').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('done');
    const n = card.querySelector('.note');
    if (n) n.textContent = note;
  }

  // ---------- olay işleme ----------

  function onEvent(t: Tab, ev: Record<string, any>): void {
    switch (ev.type) {
      case 'turn_start':
        if (!t.turnStartedAt) t.turnStartedAt = Date.now();
        setBusy(t, true);
        setStage(t, 'Düşünüyor…');
        endStream(t);
        break;
      case 'reasoning_delta': {
        if (!t.reasoningEl) {
          const d = el('details', 'reasoning');
          d.appendChild(el('summary', '', 'Düşünme'));
          t.reasoningEl = d.appendChild(el('div', 'body'));
          add(t, d);
          t.assistantEl = undefined;
          t.assistantText = '';
        }
        t.reasoningEl.textContent += ev.text;
        setStage(t, 'Düşünüyor…');
        scroll(t);
        break;
      }
      case 'assistant_delta':
        if (!t.assistantEl) {
          t.assistantEl = add(t, msgEl('assistant', '', true));
          setStage(t, 'Yazıyor…');
          t.assistantText = '';
          t.reasoningEl = undefined;
        }
        t.assistantText += ev.text;
        queueRender(t);
        break;
      case 'tool_call': {
        endStream(t);
        const card = el('details', 'tool running');
        const sum = el('summary');
        sum.appendChild(el('span', 'state', '⏳'));
        sum.appendChild(el('span', 'name', ev.name));
        sum.appendChild(el('span', 'arg', shortArgs(ev.args)));
        card.appendChild(sum);
        card.appendChild(preWithCopy('args', JSON.stringify(ev.args, null, 2)));
        t.toolCards.set(ev.call_id, add(t, card));
        setStage(t, `${ev.name} çalışıyor…`);
        break;
      }
      case 'tool_result': {
        const card = t.toolCards.get(ev.call_id);
        if (!card) break;
        card.classList.remove('running');
        card.classList.add(ev.ok ? 'ok' : 'fail');
        card.querySelector('.state')!.textContent = ev.ok ? '✓' : '✗';
        card.appendChild(preWithCopy('result', ev.summary + (ev.output_truncated ? '\n… (kırpıldı)' : '')));
        setStage(t, 'Düşünüyor…');
        break;
      }
      case 'file_change_proposed':
        endStream(t);
        t.proposals.set(ev.request_id, ev.path);
        break;
      case 'approval_request':
        endStream(t);
        approvalCard(t, ev);
        setStage(t, 'Onayını bekliyor', true);
        break;
      case 'ask_user':
        endStream(t);
        askCard(t, ev);
        setStage(t, 'Cevabını bekliyor', true);
        break;
      case 'todos':
        t.todos = ev.items || [];
        if (t === cur) renderTodos();
        break;
      case 'turn_end': {
        endStream(t);
        const took = t.turnStartedAt ? ` · ${formatElapsed(Date.now() - t.turnStartedAt)}` : '';
        setBusy(t, false);
        const files: string[] = ev.changed_files || [];
        const cls = ev.exit_code === 0 ? 'turn-end' : 'turn-end fail';
        const text = (ev.exit_code === 0 ? 'Tur bitti' : 'Tur bitmedi') + took + (files.length ? ` · ${files.length} dosya değişti: ${files.join(', ')}` : '');
        add(t, el('div', cls, text));
        if (ev.exit_code !== 0) {
          // CLI'ın verdiği neden (maks. adım, iptal, API hatası) görünmeden "hata" demek işe yaramaz.
          const reason = String(ev.result || '').trim().split('\n')[0] || 'CLI neden bildirmedi; ayrıntı için Evren: Logları göster.';
          const why: Record<string, string> = {
            max_steps: 'Adım sınırına ulaşıldı', interrupted: 'Tur iptal edildi', stuck: 'Ajan takıldı',
            budget: 'Bütçe doldu', exception: 'CLI hata verdi', error: 'Tur hatayla bitti',
          };
          add(t, el('div', 'error', ev.outcome && why[ev.outcome] ? `${why[ev.outcome]}: ${reason}` : reason));
        }
        break;
      }
      case 'error':
        add(t, el('div', 'error', `${ev.code}: ${ev.message}`));
        break;
      case 'session_loaded':
        t.logEl.textContent = '';
        t.toolCards.clear();
        t.proposals.clear();
        endStream(t);
        t.todos = [];
        if (t === cur) renderTodos();
        for (const m of ev.messages || []) {
          t.logEl.appendChild(msgEl(m.role === 'user' ? 'user' : 'assistant', String(m.text ?? '')));
        }
        add(t, el('div', 'turn-end', ev.session_id ? `Oturum yüklendi: ${ev.session_id}` : 'Yeni oturum'));
        break;
    }
  }

  function approvalCard(t: Tab, ev: Record<string, any>): void {
    const card = el('div', `card approval kind-${ev.kind}`);
    card.dataset.request = ev.request_id;
    card.appendChild(el('div', 'title', ev.title || 'Onay gerekiyor'));
    if (ev.detail) card.appendChild(preWithCopy('detail', ev.detail));
    const row = el('div', 'row');
    if (t.proposals.has(ev.request_id)) {
      const show = el('button', 'secondary', 'Diff\'i göster') as HTMLButtonElement;
      show.onclick = () => vscode.postMessage({ type: 'showDiff', sid: t.id, request_id: ev.request_id });
      row.appendChild(show);
      card.appendChild(el('div', 'hint', `${t.proposals.get(ev.request_id)} — sağ tarafı düzenleyip kabul edebilirsiniz.`));
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
        vscode.postMessage({ type: 'approval', sid: t.id, request_id: ev.request_id, decision });
      };
      row.appendChild(b);
    }
    card.appendChild(row);
    card.appendChild(el('div', 'note'));
    add(t, card);
  }

  function askCard(t: Tab, ev: Record<string, any>): void {
    const card = el('div', 'card ask');
    card.dataset.request = ev.request_id;
    card.appendChild(el('div', 'title', ev.question));
    const answer = (a: string) => {
      if (!a.trim()) return;
      disableCard(card, `Yanıt: ${a}`);
      vscode.postMessage({ type: 'askAnswer', sid: t.id, request_id: ev.request_id, answer: a });
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
    add(t, card);
    if (t === cur) free.focus();
  }

  function renderTodos(): void {
    const items = cur?.todos ?? [];
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

  function onStatus(t: Tab, s: Record<string, any>): void {
    t.status = s;
    t.ready = s.state === 'ready';
    if (!t.ready && t.busy) {
      t.busy = false;
      t.turnStartedAt = 0;
    }
    const wasBusy = t.busy;
    t.busy = !!s.busy;
    if (t.busy && !wasBusy && !t.turnStartedAt) t.turnStartedAt = Date.now();
    if (!t.busy) t.turnStartedAt = 0;
    if (t === cur) renderActive();
  }

  // ---------- geçmiş ----------

  function closeHistory(): void {
    historyEl.hidden = true;
    logs.hidden = false;
  }

  function openHistory(items: HistoryEntry[]): void {
    historyItems = items;
    historyEl.hidden = false;
    logs.hidden = true;
    renderHistory();
    histFilter.focus();
  }

  function formatWhen(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderHistory(): void {
    const q = histFilter.value.trim().toLocaleLowerCase('tr-TR');
    const shown = historyItems.filter((h) => !q || `${h.title} ${h.model} ${h.session_id}`.toLocaleLowerCase('tr-TR').includes(q));
    histList.textContent = '';
    if (!shown.length) {
      histList.appendChild(el('div', 'empty', historyItems.length ? 'Eşleşen oturum yok.' : 'Bu çalışma alanında kayıtlı oturum yok.'));
      return;
    }
    for (const h of shown) {
      const row = el('button', `hist${h.open ? ' open' : ''}`) as HTMLButtonElement;
      row.type = 'button';
      row.dataset.sid = h.session_id;
      row.appendChild(el('div', 'h-title', h.title || h.session_id));
      const meta = [formatWhen(h.at), h.model, h.mode, h.messages ? `${h.messages} mesaj` : ''].filter(Boolean).join(' · ');
      row.appendChild(el('div', 'h-meta', meta + (h.open ? ' · açık' : '')));
      histList.appendChild(row);
    }
  }

  histList.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.hist') as HTMLElement | null;
    if (!row?.dataset.sid) return;
    vscode.postMessage({ type: 'resumeHistory', session_id: row.dataset.sid });
    closeHistory();
  });
  histFilter.addEventListener('input', renderHistory);
  $<HTMLButtonElement>('histclose').onclick = closeHistory;
  $<HTMLButtonElement>('histbtn').onclick = () => {
    if (historyEl.hidden) vscode.postMessage({ type: 'history' });
    else closeHistory();
  };
  $<HTMLButtonElement>('newtab').onclick = () => vscode.postMessage({ type: 'newTab' });

  tablist.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tab = target.closest('.tab') as HTMLElement | null;
    if (!tab?.dataset.sid) return;
    vscode.postMessage({ type: target.closest('.x') ? 'closeTab' : 'selectTab', sid: tab.dataset.sid });
    if (!target.closest('.x')) closeHistory();
  });
  // Orta tık sekmeyi kapatır.
  tablist.addEventListener('auxclick', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement | null;
    if (e.button === 1 && tab?.dataset.sid && tabs.size > 1) vscode.postMessage({ type: 'closeTab', sid: tab.dataset.sid });
  });

  // ---------- kopyalama ----------

  function copyText(text: string, btn: HTMLElement): void {
    vscode.postMessage({ type: 'copy', text });
    const old = btn.textContent;
    btn.textContent = 'Kopyalandı ✓';
    window.setTimeout(() => (btn.textContent = old), 1200);
  }

  logs.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button.copy') as HTMLElement | null;
    if (!btn) return;
    e.preventDefault();
    const wrap = btn.closest('.codewrap');
    if (wrap) {
      copyText(wrap.querySelector('pre')?.textContent ?? '', btn);
      return;
    }
    const msg = btn.closest('.msg') as HTMLElement | null;
    if (msg) copyText(raws.get(msg) ?? msg.textContent ?? '', btn);
  });

  // ---------- eklentiden gelen mesajlar ----------

  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'tabs':
        if (Array.isArray(m.tabs)) applyTabs(m.tabs as TabInfo[], String(m.active ?? ''));
        break;
      case 'tabClosed':
        break; // applyTabs kalanları temizler
      case 'history':
        if (Array.isArray(m.items)) openHistory(m.items as HistoryEntry[]);
        break;
      case 'event': {
        const t = tabFor(m.sid);
        if (t && m.ev && typeof m.ev.type === 'string') onEvent(t, m.ev);
        break;
      }
      case 'status': {
        const t = tabFor(m.sid);
        if (t) onStatus(t, m);
        break;
      }
      case 'userMessage': {
        const t = tabFor(m.sid);
        if (!t) break;
        endStream(t);
        const d = add(t, msgEl('user', String(m.text)));
        if (Array.isArray(m.attachments) && m.attachments.length) d.insertBefore(el('div', 'att', '📎 ' + m.attachments.join(', ')), d.querySelector('.copy'));
        // turn_start gelmeden de beklendiği görünsün.
        t.turnStartedAt = Date.now();
        setBusy(t, true);
        setStage(t, 'Gönderiliyor…');
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
        const t = tabFor(m.sid);
        if (!t) break;
        const card = t.logEl.querySelector(`.approval[data-request="${CSS.escape(m.request_id)}"]`);
        if (t.busy) setStage(t, 'Düşünüyor…');
        if (card) disableCard(card, m.decision === 'deny' ? 'Reddedildi' : m.edited ? 'Düzenlenmiş içerikle kabul edildi' : m.decision === 'always' ? 'Her zaman izinli' : 'Kabul edildi');
        break;
      }
      case 'pendingCleared': {
        const t = tabFor(m.sid);
        t?.logEl.querySelectorAll('.card:not(.done)').forEach((c) => disableCard(c, 'Geçersiz (tur bitti)'));
        break;
      }
    }
  });

  // ---------- kullanıcı girişleri ----------

  function send(): void {
    const t = cur;
    const text = input.value;
    if (!t || !text.trim() || t.busy || !t.ready) return;
    vscode.postMessage({ type: 'send', sid: t.id, text });
    input.value = '';
    input.style.height = '';
  }

  function cancel(): void {
    if (!cur) return;
    setStage(cur, 'Durduruluyor…');
    vscode.postMessage({ type: 'cancel', sid: cur.id });
  }

  function showMode(mode: string): void {
    modeSel.value = mode;
    modeSel.className = `chip mode-${mode}`;
  }

  function setMode(mode: string): void {
    if (!cur) return;
    showMode(mode);
    vscode.postMessage({ type: 'setMode', sid: cur.id, mode });
  }

  sendBtn.onclick = send;
  stopBtn.onclick = cancel;
  $<HTMLButtonElement>('attach').onclick = () => vscode.postMessage({ type: 'pickFile' });
  modelBtn.onclick = () => cur && vscode.postMessage({ type: 'pickModel', sid: cur.id });
  modeSel.onchange = () => setMode(modeSel.value);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && cur?.busy) {
      cancel();
    } else if (e.key === 'Tab' && e.shiftKey && !cur?.busy) {
      e.preventDefault();
      const modes = Array.from(modeSel.options).map((o) => o.value);
      setMode(modes[(modes.indexOf(modeSel.value) + 1) % modes.length]);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !historyEl.hidden) closeHistory();
  });
  // Metin kutusu içeriğe göre büyür (CSS max-height ile sınırlı).
  function autosize(): void {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }
  input.addEventListener('input', autosize);
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

  vscode.postMessage({ type: 'ready' });
})();
