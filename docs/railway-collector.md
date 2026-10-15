# collector servisi (Railway)

collector, ham verileri toplayıp Postgres'e yazan tek süreç. Şu an Binance L/S (5 dakikada bir), heatmap (12h, 24h, 48h saatte bir), Axi mumları (1m–1d, dakikada bir) ve Axi sembol bilgisini (6 saatte bir) topluyor; bias sonraki adımda. Açılışta migration'ları kendisi uygular.

Railway, Ağustos 2026 sonundan beri yeni servislerde `railway.toml` okumuyor; ayarlar panelden girilir.

## 1. Servisi aç

Yeni projede New → GitHub Repo → `ariagdere/paraleltrading`.

- Repo listede çıkmıyorsa GitHub'da Railway uygulamasının repo erişimine `paraleltrading`'i ekle.
- Railway monorepo'daki paketler için ayrı servisler önerirse yalnız birini bırak ve adını `collector` yap. `packages/db` servis değil.

## 2. Ayarlar (Settings)

| Ayar | Değer |
|---|---|
| Root Directory | boş (repo kökü) |
| Branch | `main` |
| Builder | Railpack (varsayılan) |
| Build Command | boş |
| Start Command | `node --import tsx apps/collector/src/index.ts` |
| Watch Paths | `/apps/collector/**`, `/packages/db/**`, `/package.json`, `/package-lock.json` |
| Restart Policy | Always |
| Region | eski `hakari-lsr-refresher` servisiyle aynı bölge |
| Replicas | 1 |
| Public Networking | gerekmez (servisin HTTP ucu yok) |

- Start Command npm üzerinden değil: npm kapanma sinyalini sürece iletmiyor. Doğrudan node ile servis deploy sırasında düzgün kapanır ve yarım kalan çalıştırmayı kaydeder.
- Watch Paths sayesinde ileride core ya da web değişince collector yeniden başlamaz.
- Bölge: Binance bazı bulut bölgelerinden gelen istekleri reddediyor (HTTP 451). Eski L/S servisi sorunsuz çalıştığı için onun bölgesi güvenli.

## 3. Değişkenler (Variables)

| Değişken | Değer |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `APIFY_TOKEN` | `${{shared.APIFY_TOKEN}}` |
| `APIFY_ACT_ID` | `${{shared.APIFY_ACT_ID}}` |
| `METAAPI_TOKEN` | `${{shared.METAAPI_TOKEN}}` |
| `METAAPI_ACCOUNT_ID` | `${{shared.METAAPI_ACCOUNT_ID}}` |

`Postgres` yerine kanvastaki Postgres servisinin adı yazılır; değeri `${{` yazınca açılan listeden seçmek en güvenlisi. Bir değişken eksikse o kaynak kapalı kalır ve sağlık tablosunda hata olarak görünür.

İsteğe bağlı; varsayılanlar yeterli:

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `METAAPI_REGION` | `london` | MetaApi bölgesi (eski dashboard'la aynı) |
| `AXI_BACKFILL_FROM` | `2026-09-18T00:00:00Z` | İlk açılışta Axi mumlarının başlangıcı; her dilimde bunun 1000 mum öncesine kadar gidilir (göstergeler ısınsın) |
| `AXI_PAGE_PAUSE_MS` | `2000` | Geriye doldururken MetaApi sayfaları arası bekleme (istek kotası eski dashboard'la ortak) |
| `AXI_BACKFILL_RETRY_MINUTES` | `10` | Geriye doldurma hata verirse ilk tekrar; her hatada ikiye katlanır, en çok 60 |
| `HEATMAP_BUDGET_USD` | `28` | Ay sonu tahmini bunu aşarsa önce 48h, sonra 24h iki saatte bire iner |
| `HEATMAP_RUN_COST_USD` | `0.01` | Çalıştırma başına ücret |
| `HEATMAP_WAIT_MINUTES` | `15` | Bir çalıştırmanın bitmesi için en uzun bekleme |
| `LSR_BACKFILL_FROM` | `2026-09-18T00:00:00Z` | İlk açılışta L/S'nin başlangıcı (Binance yalnız son 30 günü veriyor) |

Apify hesabındaki aylık kullanım limiti $29 olmalı; bekçi bir sebeple çalışmazsa son emniyet o.

## 4. İlk açılışta beklenenler

Deploy loglarında sırayla:

```
şema güncel, uygulanacak migration yok
[collector] başladı
[lsr] global: ... nokta yazıldı
[lsr] top_position: ... nokta yazıldı
[axi] BTCUSD sembol bilgisi kaydedildi
[axi] 1m: ... mum yazıldı
...
[axi] 1d: ... mum yazıldı
```

- İlk satır, şema elle (DBeaver) kurulduysa ilk açılışta `uygulandı: 001_ham_veri.sql` olur; tablolara dokunmaz, yalnız kaydını tutar.
- L/S ilk açılışta 18 Eylül'den bugüne doldurulur (metrik başına yaklaşık 8.000 nokta).
- Axi: ilk dakikada her dilime en yeni 999 mum yazılır (`[axi] 1m: 999 mum yazıldı`), canlı veri hemen başlar. Geçmiş, ayrı bir iş olarak dakikada bir 40 saniyelik dilimlerle geriye doldurulur (`[axi] 5m: geriye ... mum yazıldı, ... tarihine inildi`).
- MetaApi derin geçmişi bazen zamanında getiremiyor (`Timed out waiting for bars`). O zaman `[axi] geriye doldurma 1m: ... tekrar denenecek` yazar; sayfa küçülür ve 10, 20, 40, 60 dakika arayla yeniden denenir. Canlı mumlar bundan etkilenmez.
- MetaApi'de daha eski mum yoksa `[axi] 1m: MetaApi geçmişi ... tarihinde bitiyor` yazar; hepsi bitince `[axi] geriye doldurma tamamlandı`.
- Heatmap ilk kez bir sonraki saat başından 30 saniye sonra çalışır; üç çalıştırma 5 dakika içinde biter.

Deploy sırasında eski süreç kapanana kadar yenisi `başka bir collector çalışıyor; kilit bekleniyor` yazar; bu normal, aynı saat iki kez heatmap başlatılmasın diye.

## 5. DBeaver'da kontrol

```sql
-- kaynak başına son durum
SELECT source, last_success_at, last_source_time, consecutive_failures, last_error
FROM collector_status ORDER BY source;

-- son heatmap'ler
SELECT span, received_at, update_time, n_cells FROM heatmap_snapshots ORDER BY id DESC LIMIT 6;

-- çalıştırmalar ve maliyet
SELECT source, started_at, ok, cost_usd, error, detail->>'mode' AS mod
FROM collector_runs ORDER BY id DESC LIMIT 10;

-- L/S kapsamı
SELECT metric, count(*), min(ts), max(ts) FROM lsr_series GROUP BY metric;

-- Axi mum kapsamı
SELECT timeframe, count(*), min(open_time), max(open_time), count(*) FILTER (WHERE spread_points IS NULL) AS spreadsiz
FROM axi_candles GROUP BY timeframe ORDER BY min(open_time) DESC;
```

- Sağlıkta `consecutive_failures` 0 olmalı.
- `lsr:*` satırlarında `HTTP 451` görürsen bölge uygun değil: Region'ı eski L/S servisininkine çevir.
- `heatmap:budget` bütçe bekçisinin satırı. Hata görürsen Apify token'ı hesap kullanımını okuyamıyor; heatmap normal planla devam eder.
- `axi:backfill` geriye doldurmanın satırı: hata görürsen `last_error` hangi dilimde nereye kadar inildiğini ve ne zaman tekrar deneneceğini söyler. Canlı dilimlerin satırları bundan ayrı.
- `axi:*` satırlarında `last_source_time` o dilimin son kapanmış mumunun açılışı. Örneğin 1d için dünün 21:00 UTC'si (İstanbul 00:00): bugünün günlük mumu henüz oluşuyor.
