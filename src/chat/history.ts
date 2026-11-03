// Geçmiş oturumlar: `<çalışma alanı>/.evren/sessions/<damga>.json` dosyaları doğrudan diskten okunur.
// CLI'a sorulmaz; böylece tur sürerken ve CLI kapalıyken de liste görünür.

import * as fs from 'fs';
import * as path from 'path';

export interface HistoryItem {
  session_id: string;
  title: string;
  model: string;
  mode: string;
  /** Dosya adındaki damgadan (YYYYMMDD-HHMMSS) üretilen ISO zamanı; çözülemezse boş. */
  at: string;
  /** Kaç kullanıcı/asistan mesajı var (yaklaşık bilgi). */
  messages: number;
}

/** Bu boyutun üstündeki dosyalar parse edilmez; yalnız kimlik ve tarih gösterilir. */
const MAX_PARSE_BYTES = 8 * 1024 * 1024;

export function stampToIso(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : '';
}

export function sessionsDir(root: string): string {
  return path.join(root, '.evren', 'sessions');
}

/** En yeni önce, en çok `limit` oturum. Okunamayan dosyalar atlanır. */
export async function listHistory(root: string, limit = 100): Promise<HistoryItem[]> {
  const dir = sessionsDir(root);
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, limit);
  } catch {
    return [];
  }
  const items = await Promise.all(names.map((n) => readItem(dir, n)));
  return items.filter((i): i is HistoryItem => !!i);
}

async function readItem(dir: string, name: string): Promise<HistoryItem | undefined> {
  const id = name.slice(0, -'.json'.length);
  const base: HistoryItem = { session_id: id, title: '', model: '', mode: '', at: stampToIso(id), messages: 0 };
  const file = path.join(dir, name);
  try {
    const st = await fs.promises.stat(file);
    if (st.size > MAX_PARSE_BYTES) {
      return base;
    }
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    return {
      ...base,
      title: typeof data.title === 'string' ? data.title : '',
      model: typeof data.model === 'string' ? data.model : '',
      mode: typeof data.mode === 'string' ? data.mode : '',
      messages: msgs.length,
    };
  } catch {
    return undefined;
  }
}
