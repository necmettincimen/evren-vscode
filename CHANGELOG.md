# Değişiklik Günlüğü

Format [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/), sürümleme [SemVer](https://semver.org/lang/tr/).

## [0.1.1] - 2026-10-28

### Değişti
- Başlatma ayarları (`evren.autoApprove`, `evren.model`, `evren.allowedTools`, `evren.cliPath` vb.) değişince CLI süreci kendiliğinden yeniden başlar; tur sürüyorsa tur bitince.

## [0.1.0] - 2026-10-28

İlk herkese açık sürüm. En az **evren-cli 3.10.0** gerekir (stdio protokolü v1).

### Eklendi
- Sohbet paneli: akan yanıt, düşünme akışı, araç kartları, yapılacaklar listesi, token kullanımı.
- Dosya değişikliklerini diff ile onaylama, düzenleyerek onaylama, reddetme ve her zaman izin verme.
- Oturum listesi, devam etme, yeni oturum; kip (normal/plan/ask) ve model seçimi.
- Seçimi sohbete ekleme ve `@yol#L10-20` bahsetmeleri.
- Ajanlar paneli: çalışan Evren süreçleri ve plan ajanlarının günlükleri.
- `protocol/stdio-v1.schema.json` sözleşme testi ve gerçek CLI ile LLM'siz uyumluluk testi.
