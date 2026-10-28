// Gerçek `evren --stdio` ile Extension Development Host içinde uçtan uca tur.
// Kullanım: npm run test:e2e  (LLM çağrısı yapar; kota harcar)

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'evren e2e '));
  fs.writeFileSync(path.join(ws, 'README.md'), '# Deneme\n\nBu bir test deposudur.\n', 'utf8');
  cp.execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm ilk', { cwd: ws });
  const exe = process.env.VSCODE_EXE ||
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  try {
    await runTests({
      vscodeExecutablePath: fs.existsSync(exe) ? exe : undefined,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'index.js'),
      launchArgs: [ws, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { EVREN_E2E_WS: ws },
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
