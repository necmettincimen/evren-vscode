# Evren — VS Code eklentisi

EVREN CLI için kenar çubuğu sohbet paneli. Eklenti LLM'e bağlanmaz: `evren --stdio`
sürecini başlatır ve [stdio protokolü v1](../evren-cli/docs/stdio-protocol.md) ile konuşur.
Ajan mantığı, model erişimi ve anahtarlar CLI'da kalır.

## Özellikler

- Akan yanıt (`assistant_delta`, markdown) ve katlanabilir düşünme (`reasoning_delta`)
- Araç kartları: ad, kısa argüman, çalışıyor / tamam / hata, genişletilebilir çıktı
- Dosya değişikliği: `file_change_proposed` gelince `vscode.diff` açılır (sol mevcut, sağ önerilen).
  Sağ taraf düzenlenebilir; kabul edilince düzenlenmiş metin `edited_content` olarak gider.
  Panelde ve diff başlığında Kabul / Reddet / Her zaman izin ver
- Komut / ssh onayı: komut metni panelde gösterilir
- `ask_user` soru kartı (seçenek düğmeleri ya da serbest metin), yapılacaklar paneli (`todos`)
- Durdur (`cancel`, Esc), yeni oturum, oturum geçmişi ve `resume`, model ve kip seçimi
- Durum çubuğunda model · kip · token
- `@` ile dosya seçici, `Ctrl+Alt+K` seçimi `@yol#L10-20` olarak ekler
- stderr ve süreç günlüğü **Evren** çıktı kanalında (`Evren: Show Logs`)

## Kurulum

Önkoşul: EVREN CLI ≥ 3.10.0 PATH'te (`evren --version`). Eski sürümde eklenti güncelleme uyarısı verir.

```
npm install
npm run compile
```

Geliştirme: VS Code'da bu klasörü açıp **F5** (Extension Development Host).
Paket: `npx @vscode/vsce package` → `.vsix`, ardından *Extensions: Install from VSIX…*.

## Ayarlar

| ayar | varsayılan | anlam |
|---|---|---|
| `evren.cliPath` | `evren` | çalıştırılabilir dosya (ad ya da tam yol; `.cmd`/`.bat` desteklenir) |
| `evren.pythonPath` | — | doluysa `<python> -m src.cli --stdio` kullanılır |
| `evren.cliRepo` | — | `pythonPath` ile birlikte evren-cli kaynak dizini |
| `evren.model` | — | başlangıç modeli |
| `evren.defaultMode` | `normal` | `normal` / `plan` / `ask` |
| `evren.autoApprove` | `none` | `edits`: düzenleme araçları onaysız; `all`: `--yes` |
| `evren.allowedTools` | `[]` | `--allowed-tools` listesi |
| `evren.extraEnv` | `{}` | sürece eklenecek ortam değişkenleri (API anahtarı yazmayın) |
| `evren.autoAttachActiveFile` | `false` | her isteğe aktif dosyayı ekle |

API anahtarları ayarlara yazılmaz; CLI kendi yapılandırmasını (`~/.evren`, `secret_vault`) kullanır.

## Komutlar

`Evren: Open Chat`, `New Session`, `Resume Session`, `Add Selection to Chat`, `Cancel`,
`Select Model`, `Select Mode`, `Restart CLI`, `Show Logs`.

## Protokol sürüm uyumu

- Eklenti `v: 1` mesajları gönderir ve yalnız `v: 1` olayları işler; tanımadığı olay tiplerini atlar.
- `ready.version` < 3.10.0 ise süreç durdurulur ve güncelleme talimatı gösterilir.
- Süreç çökerse bekleyen onaylar ve diff sekmeleri kapatılır; panelde tek tıkla yeniden başlatma.

## Testler

```
npm test          # derleme + protokol istemcisi birim testleri (sahte süreç)
npm run test:e2e  # gerçek evren --stdio ile Extension Host içinde bir tur (LLM kotası harcar)
```

`test:e2e` geçici bir git deposunda README'ye satır ekletir, diff'in sağ tarafını düzenleyip onaylar
ve düzenlenmiş içeriğin diske yazıldığını, ardından `list_sessions` / `resume` akışını doğrular.
Kurulu VS Code'u kullanır (`VSCODE_EXE` ile değiştirilebilir).
