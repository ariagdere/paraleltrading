# paraleltrading

Hakari 2: sürekli veri akışı ve sonraki aşamada strateji motoru (simülasyon ve sanal broker).
Plan: proje dokümanı "Hakari 2 — Sürekli Veri Akışı Planı".

## Yapı

| Yol | İçerik |
|---|---|
| `packages/db` | Postgres bağlantısı, migration çalıştırıcı, şema (`migrations/`) |
| `apps/collector` | (sonra) Axi mumları, L/S, heatmap ve bias toplayıcı; açılışta migration'ları uygular |
| `apps/core` | (sonra) göstergeler, L/S açıları, cluster'lar |
| `apps/web` | (sonra) sağlık ve son değerler sayfası |

## Kurallar

- Veritabanında bütün zamanlar UTC; İstanbul saati (UTC+3) yalnız ekranda.
- Şema değişikliği yeni bir migration dosyasıyla yapılır (`002_...sql`); uygulanmış dosya değiştirilmez.
- Gizli bilgiler (veritabanı adresi, MetaApi ve Apify anahtarları) yalnız Railway değişkenlerinde durur, repoya girmez.

## Komutlar

Node 22 veya üstü.

```
npm install
DATABASE_URL="..." PGSSL=true npm run migrate   # şemayı uygular
npm run typecheck
```

Postgres kurulumu: [docs/postgres-kurulum.md](docs/postgres-kurulum.md)
