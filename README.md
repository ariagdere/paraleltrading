# paraleltrading

Hakari 2: sürekli veri akışı ve sonraki aşamada strateji motoru (simülasyon ve sanal broker).
Plan: proje dokümanı "Hakari 2 — Sürekli Veri Akışı Planı".

## Yapı

| Yol | İçerik |
|---|---|
| `packages/db` | Postgres bağlantısı, migration çalıştırıcı, şema (`migrations/`); servislerin ortak sağlık kaydı ve zamanlayıcısı |
| `apps/collector` | Binance L/S (5 dk), heatmap (saatlik; başarısız olursa aynı saatte yeniden), Axi mumları 1m–1d (dakikada bir; 30 dakikada bir boşluk denetimi), sembol bilgisi ve günlük bias raporları toplayıcı; isteğe bağlı eski DB kopyası; açılışta migration'ları uygular |
| `apps/core` | Axi göstergeleri: ZLEMA bölgesi, RSI 14, ATR 14 (15m, 1h, 4h, 1d); heatmap seviyeleri: cluster'lar, bant likiditesi, baz; L/S açıları (global ve TT; 5m, 15m, 1h, 4h); dakikada bir |
| `apps/web` | Tarayıcıdan açılan konsol (Next.js): giriş; Piyasa sayfası (fiyat, mumlarla birlikte likidasyon heatmap'i ve cluster'lar, göstergeler, L/S, bias); Sağlık sayfası (her kaynağın son verisi, gecikmeler, hatalar); veritabanını yalnız okur |

## Kurallar

- Veritabanında bütün zamanlar UTC; İstanbul saati (UTC+3) yalnız ekranda.
- Şema değişikliği yeni bir migration dosyasıyla yapılır (`002_...sql`); uygulanmış dosya değiştirilmez.
- Gizli bilgiler (veritabanı adresi, MetaApi ve Apify anahtarları, web giriş bilgileri) yalnız Railway değişkenlerinde durur, repoya girmez.

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
