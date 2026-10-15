# collector servisi (Railway)

collector, ham verileri toplayıp Postgres'e yazan tek süreç. Şu an Binance L/S (5 dakikada bir) ve heatmap (12h, 24h, 48h saatte bir) topluyor; Axi mumları ve bias sonraki adımda. Açılışta migration'ları kendisi uygular.

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

İsteğe bağlı; varsayılanlar yeterli:

| Değişken | Varsayılan | Anlamı |
|---|---|---|
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
```

L/S ilk açılışta 18 Eylül'den bugüne doldurulur (metrik başına yaklaşık 8.000 nokta). Heatmap ilk kez bir sonraki saat başından 30 saniye sonra çalışır; üç çalıştırma 5 dakika içinde biter.

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
```

- Sağlıkta `consecutive_failures` 0 olmalı.
- `lsr:*` satırlarında `HTTP 451` görürsen bölge uygun değil: Region'ı eski L/S servisininkine çevir.
- `heatmap:budget` bütçe bekçisinin satırı. Hata görürsen Apify token'ı hesap kullanımını okuyamıyor; heatmap normal planla devam eder.
