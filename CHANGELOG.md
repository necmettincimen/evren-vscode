# Değişiklik Günlüğü

Format [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/), sürümleme [SemVer](https://semver.org/lang/tr/).

## [0.2.0] - 2026-11-03

### Eklendi
- Sohbet sekmeleri: her sekme ayrı bir CLI süreci; en fazla 6 oturum aynı anda paralel çalışır (meşgul/yanıt bekliyor göstergesi, orta tıkla kapatma).
- Geçmiş paneli: çalışma alanındaki `.evren/sessions` oturumları listelenir, aranır ve tıklayınca devam ettirilir.
- Kopyalama: sohbet metni seçilip kopyalanabilir; mesajlara, kod bloklarına ve araç çıktılarına Kopyala düğmesi eklendi. Yanıt akarken seçim bozulmaz.
- Rust CLI 4.x `turn_end.outcome` alanı (adım sınırı, iptal, bütçe…) tur sonunda gösterilir; şema evren-rs ile eşitlendi.

### Değişti
- Diff onayları sekme kimliğiyle ad alanlıdır; iki sekmede aynı `request_id` çakışmaz.
- Durum çubuğu çalışan oturum sayısını gösterir; ajan ağacı tüm sekme süreçlerini "bu pencere" olarak tanır.

## [0.1.3] - 2026-11-02

### Değişti
- En düşük VS Code sürümü 1.90 yerine 1.86 (kullanılan API'ler 1.86'da mevcut).

## [0.1.2] - 2026-10-28

### Değişti
- Tur başarısız bittiğinde CLI'ın bildirdiği neden (maksimum adım, iptal, API hatası) sohbette gösterilir; yalnız "hata/iptal" yazılmaz.

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
