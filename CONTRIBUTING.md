# Katkı Rehberi

Katkılarınız memnuniyetle karşılanır. Büyük değişiklikler için önce bir issue açın.

## Geliştirme ortamı

```bash
npm ci
npm run compile
```

VS Code'da `F5` tuşu Extension Development Host'u açar. Eklenti, PATH'teki `evren` komutunu (ya da `evren.cliPath` ayarını) kullanır.

## Testler

| Komut | Ne yapar | LLM gerekir mi? |
|---|---|---|
| `npm test` | Birim testleri ve şema sözleşme testi (`protocol/stdio-v1.schema.json`) | Hayır |
| `npm run test:compat` | Gerçek `evren --stdio` sürecini evren-cli'nin sahte model sunucusuyla koşturur | Hayır |
| `npm run test:e2e` | Extension Development Host içinde uçtan uca senaryolar | Senaryoya göre değişir |

`EVREN_E2E_ONLY=ayarlar,ajanlar npm run test:e2e` yalnız LLM gerektirmeyen senaryoları çalıştırır.

## Protokol ve CLI sürümü

- `protocol/CLI_TAG`: sözleşmenin alındığı evren-cli etiketidir. CI, şemayı ve sahte sunucuyu bu etiketten indirir.
- `src/cli/protocol.ts` içindeki `COMMAND_TYPES`, `EVENT_TYPES`, `PROTOCOL_VERSION` ve `MIN_CLI_VERSION` değerleri şemayla aynı kalmalıdır. Bunu `contract.test.ts` denetler.
- Yeni bir CLI özelliğine bağımlı olduğunuzda `MIN_CLI_VERSION`, `CLI_TAG`, vendor edilen şema ve README'deki uyumluluk tablosu birlikte güncellenir.

## Commit ve sürüm

- Commit mesajları kısa ve Türkçe olsun. Her PR'da CI yeşil olmalıdır.
- Sürüm çıkarmak için `package.json` sürümünü ve `CHANGELOG.md` dosyasını güncelleyin, ardından `vX.Y.Z` etiketini push edin. Release iş akışı `.vsix` dosyasını ekler.
