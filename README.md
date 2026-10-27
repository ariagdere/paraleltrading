# paraleltrading

Hakari 2: sürekli veri akışı ve sonraki aşamada strateji motoru (simülasyon ve sanal broker).
Plan: proje dokümanı "Hakari 2 — Sürekli Veri Akışı Planı".

## Yapı

| Yol | İçerik |
|---|---|
| `packages/db` | Postgres bağlantısı, migration çalıştırıcı, şema (`migrations/`); servislerin ortak sağlık kaydı ve zamanlayıcısı |
| `apps/collector` | Binance L/S (5 dk), heatmap (saatlik; başarısız olursa aynı saatte yeniden), Axi mumları 1m–1d (dakikada bir; 30 dakikada bir boşluk denetimi), sembol bilgisi ve günlük bias raporları toplayıcı; isteğe bağlı eski DB kopyası; açılışta migration'ları uygular |
| `apps/core` | Axi göstergeleri: ZLEMA bölgesi, RSI 14, ATR 14 (15m, 1h, 4h, 1d); destek/direnç bölgeleri, olayları ve gösterilecek üstte ve altta en güçlü 3 bölge (Axi 4h ve 1d, her 4h kapanışında); heatmap seviyeleri: cluster'lar, bant likiditesi, baz; L/S açıları (global ve TT; 5m, 15m, 1h, 4h); naif kuralın kararları ve benzetilen işlemleri (doğrulama, her 12h snapshot'ında); dakikada bir. Kombinasyon simülasyonu (`src/sim`): naif setup'ın ZLEMA, L/S açısı ve cluster oranı kombinasyonlarıyla taranması, şans testi, önceki bulgunun denetimi; her ayın 1'inde ve web'den istenince; sonuç ve Claude'un yorumu `sim-data` dalında |
| `apps/web` | Tarayıcıdan açılan konsol (Next.js): giriş; Piyasa sayfası (canlı fiyat, MetaApi streaming; tek grafik, oluşan mum canlı, ve katmanları: likidasyon heatmap'i, cluster'lar, destek/direnç, önceki gün/hafta; göstergeler, L/S açıları ve son 30 noktanın grafikleri, bias); Doğrulama sayfası (naif kuralın yeniden oynatması ve ileri izlemesi, gerçek naif işlemlerle karşılaştırma); Simülasyon sayfası (kombinasyon taraması, önceki bulgunun denetimi, Claude'un yorumu, "Şimdi çalıştır"); Sağlık sayfası (her kaynağın son verisi, gecikmeler, hatalar); veritabanını okur, tek yazma yolu simülasyon isteği |

## Kurallar

- Veritabanında bütün zamanlar UTC; İstanbul saati (UTC+3) yalnız ekranda.
- Şema değişikliği yeni bir migration dosyasıyla yapılır (`002_...sql`); uygulanmış dosya değiştirilmez.
- Gizli bilgiler (veritabanı adresi, MetaApi ve Apify anahtarları, GitHub token'ı, web giriş bilgileri) yalnız Railway değişkenlerinde durur, repoya girmez.
- `sim-data` dalı yalnız veri (simülasyon sonuçları ve Claude yorumları, rutinin talimatları); `main`'e birleşmez.

## Komutlar

Node 22.

```
npm install
DATABASE_URL="..." PGSSL=true npm run migrate   # şemayı uygular
npm run typecheck
npm run start -w @pt/collector                  # collector'ı yerelde çalıştırır
npm run start -w @pt/core                       # core'u yerelde çalıştırır
npm run dev -w @pt/web                          # web'i yerelde açar (WEB_USER, WEB_PASSWORD gerekir)
```

- Postgres kurulumu: [docs/postgres-kurulum.md](docs/postgres-kurulum.md)
- collector servisi: [docs/railway-collector.md](docs/railway-collector.md)
- core servisi: [docs/railway-core.md](docs/railway-core.md)
- web servisi: [docs/railway-web.md](docs/railway-web.md)
