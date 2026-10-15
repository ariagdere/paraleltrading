# collector servisi (Railway)

collector, ham verileri toplayıp Postgres'e yazan tek süreç. Binance L/S (5 dakikada bir), heatmap (12h, 24h, 48h saatte bir), Axi mumları (1m–1d, dakikada bir), Axi sembol bilgisi (6 saatte bir) ve günlük bias raporlarını (5 dakikada bir hakari-dashboard'un `bias-data` dalına bakar) topluyor. Başarısız heatmap aynı saat içinde yeniden denenir, mum serisindeki boşluklar 30 dakikada bir MetaApi'den yeniden istenir (bkz. [Tekrar denemeler](#tekrar-denemeler)). Açılışta migration'ları kendisi uygular.

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
| `AXI_GAP_RECHECK_HOURS` | `6` | Boşluk denetiminin geriye baktığı süre; bundan eski ve hâlâ dolmamış boşluk broker'ın gerçek boşluğu sayılır |
| `GITHUB_TOKEN` | boş | Bias için gerekmez (repo açık). Paylaşılan Railway IP'sinde GitHub API kotası dolarsa (`bias` satırında "kotası doldu") salt okunur bir token verilebilir |
| `HEATMAP_BUDGET_USD` | `28` | Ay sonu tahmini bunu aşarsa önce 48h, sonra 24h iki saatte bire iner |
| `HEATMAP_RUN_COST_USD` | `0.01` | Çalıştırma başına ücret |
| `HEATMAP_WAIT_MINUTES` | `15` | Bir çalıştırmanın bitmesi için en uzun bekleme |
| `HEATMAP_RETRY_DELAYS_MS` | `30000,90000` | Başarısız çalıştırmadan sonraki tekrarların beklemeleri (milisaniye); her sayı bir tekrar. `none` tekrarı kapatır |
| `LSR_BACKFILL_FROM` | `2026-09-18T00:00:00Z` | İlk açılışta L/S'nin başlangıcı (Binance yalnız son 30 günü veriyor) |
| `OLD_DATABASE_URL` | boş | Eski sistemin Postgres'i (eski projedeki Postgres servisinin `DATABASE_PUBLIC_URL` değeri). Verilirse eski DB'den kopya açılır (aşağıda) |
| `OLD_PGSSL` | `true` | Eski DB SSL kabul etmiyorsa `false` |
| `LEGACY_FROM` | boş | Heatmap ve L/S kopyasının başlangıcı; boşsa eski DB'de ne varsa |

Apify hesabındaki aylık kullanım limiti $29 olmalı; bekçi bir sebeple çalışmazsa son emniyet o.

### Tekrar denemeler

**Heatmap.** Bir pencerenin çalıştırması FAILED, ABORTED ya da TIMED-OUT biterse, çıktı boş gelirse ya da aktör hata döndürürse, başlatma veya okuma geçici bir hataya (ağ, 429, 5xx) takılırsa 30 saniye sonra yeni bir çalıştırma başlar; o da tutmazsa 90 saniye sonra bir kez daha. Üç deneme de aynı saat içinde biter.

Tekrar denenmeyenler:

- 15 dakikalık beklemede bitmeyen çalıştırma: Apify'da sürer ve ücretlenir, ikinci çalıştırma yalnız maliyeti ikiye katlar.
- Apify'ın kalıcı reddi: aylık limit dolu, token geçersiz (429 dışındaki 4xx).
- Değişmiş çıktı biçimi: tekrar denemek düzeltmez.
- Servis kapanışı (deploy): bekleyen tekrar iptal edilir.

Durum sorgusu geçici hata verirse yeni çalıştırma başlatılmaz, aynı çalıştırma sorulmaya devam eder; çıktı okunamazsa aynı çıktı 5 saniye arayla üç kez okunur.

Her deneme `collector_runs`'ta ayrı satırdır (`detail.attempt`), başlatılan her çalıştırma 0,01 dolar sayılır. Bütçe bekçisi Apify'daki gerçek harcamayı okuduğu için tekrarlar ay sonu tahminine de girer. Sağlık satırı saat başına bir kez güncellenir: üç deneme de tutmazsa `consecutive_failures` bir artar ve `last_error` sonunda `(3 deneme)` yazar.

**Axi mumları.** Boşluk denetimi 30 dakikada bir (xx:20 ve xx:50) her dilimin son 6 saatinde iki kayıtlı mum arasında eksik var mı diye bakar ve eksikleri MetaApi'den yeniden ister; boşluk başına tek istek. Geriye doldurma sürerken çalışmaz: MetaApi'nin eşzamanlı istek sınırı eski dashboard'la ortak. Axi'nin kendi kısa araları (1m'de günde 4 dakika kadar, 5m'de ayda birkaç mum) hiç gelmez; bunlar gerçek boşluk, hata sayılmaz ve 6 saat sonra istenmez olur.

**Sembol bilgisi.** Açılışta ve 6 saatte bir okunur; okunamazsa 6 saat beklenmez, 15 dakikada bir yeniden denenir.

### Eski DB'den kopya

`OLD_DATABASE_URL` verilince collector açılışta ve saatte bir (xx:40) eski veritabanından kopyalar. Eski DB'ye salt okunur oturumla bağlanır; bu her turda kontrol edilir, eski DB'ye hiçbir şey yazılmaz.

| Eski tablo | Yeni tablo | Ne kopyalanır |
|---|---|---|
| `orders`, `order_events` | `legacy_orders`, `legacy_order_events` | Hepsi; eski sistem çalıştıkça yenileri ve değişenler de gelir (doğrulama ve ileri izleme) |
| `red_folder_events` | `calendar_events` | Hepsi |
| `apify_heatmap_snapshots` | `heatmap_snapshots` (span 12h) | Ham biçimdekiler (Temmuz 2026'dan), yeni collector'ın ilk snapshot'ından öncesi |
| `lsr_series` (5m) | `lsr_series` | Yeni serinin başladığı 18 Eylül'den öncesi (Ağustos sonundan) |

Heatmap ve L/S geçmişi bir kez tamamlanınca (`collector_runs`'ta `legacy:heatmap`, `legacy:lsr`) sonraki açılışlarda yeniden taranmaz; yarıda kalırsa zaten kopyalanmış snapshot'lar yeniden indirilmez. İşlemler, olaylar ve takvim her turda güncellenir.

Eski sistem kapanınca `OLD_DATABASE_URL` silinebilir; kopyalanan veri yerinde kalır.

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
- Bias: ilk açılışta `bias-data` dalındaki bütün raporlar yazılır (`[bias] 2026-10-15T1419.json: SHORT MEDIUM, skor -45` gibi). Sonra dal 5 dakikada bir kontrol edilir; yeni rapor gelince aynı satır düşer.
- Heatmap ilk kez bir sonraki saat başından 30 saniye sonra çalışır; üç çalıştırma 5 dakika içinde biter. Biri tutmazsa `[heatmap] 48h: Apify çalıştırması FAILED (deneme 1; 30 sn sonra tekrar denenecek)`, tekrar tutunca `[heatmap] 48h: 2. deneme başarılı` yazar.
- Mum boşluğu dolunca: `[axi] 1m: 2026-10-15T19:41:00.000Z sonrasındaki boşluğa 1/1 mum geldi` (saat UTC). Boşluk yoksa satır düşmez.
- Eski DB kopyası (`OLD_DATABASE_URL` verildiyse): ilk açılışta `uygulandı: 002_eski_sistem.sql`, sonra `[eski] kopyalandı: orders ..., orderEvents ..., calendar ..., heatmap12h ..., lsr5m ...`. Sonraki saatlerde yalnız yeni ya da değişen satırlar gelir; bir şey değişmediyse satır düşmez.

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

-- heatmap tekrar denemeleri (son 24 saat)
SELECT source, started_at, ok, detail->>'attempt' AS deneme, error
FROM collector_runs
WHERE source LIKE 'heatmap:%' AND started_at > now() - interval '1 day'
  AND (NOT ok OR (detail->>'attempt')::int > 1)
ORDER BY id DESC;

-- doldurulan mum boşlukları
SELECT started_at, detail->>'tf' AS dilim, detail->>'gapStart' AS bosluk_oncesi, rows_written AS gelen, detail->>'missing' AS eksik
FROM collector_runs WHERE source = 'axi:gaps' AND ok ORDER BY id DESC LIMIT 20;

-- son bias raporları
SELECT source_file, committed_at, bias, confidence, sentiment_score, risk_regime
FROM daily_bias ORDER BY committed_at DESC LIMIT 5;

-- eski sistemden kopya
SELECT magic, count(*), min(opened_at), max(closed_at) FROM legacy_orders GROUP BY magic ORDER BY count(*) DESC;
SELECT source, count(*), min(received_at), max(received_at) FROM heatmap_snapshots GROUP BY source;
```

- Sağlıkta `consecutive_failures` 0 olmalı.
- `lsr:*` satırlarında `HTTP 451` görürsen bölge uygun değil: Region'ı eski L/S servisininkine çevir.
- `heatmap:budget` bütçe bekçisinin satırı. Hata görürsen Apify token'ı hesap kullanımını okuyamıyor; heatmap normal planla devam eder.
- `heatmap:*` satırında `last_error` sonunda `(3 deneme)` varsa o saat üç deneme de tutmamış; tek denemeyle biten hata (bekleme süresi doldu, aylık limit dolu) tekrar denenmeyen türdendir.
- `axi:gaps` boşluk denetiminin satırı. Hata görürsen MetaApi o turda yanıt vermemiş; 30 dakika sonraki tur yeniden dener. Gelmeyen boşluk hata sayılmaz.
- `axi:backfill` geriye doldurmanın satırı: hata görürsen `last_error` hangi dilimde nereye kadar inildiğini ve ne zaman tekrar deneneceğini söyler. Canlı dilimlerin satırları bundan ayrı.
- `bias` satırında `last_source_time` son raporun dala düştüğü an (simülasyonda bias'ın bilindiği an). Hata varsa `last_error` dosya adını ve sebebi söyler: çekirdek alanı (bias, güven, yön, skor, tarih) geçersiz bir rapor yazılmaz; düzeltilip dala yeniden gönderilince yazılır.
- `legacy` eski DB kopyasının satırı (yalnız `OLD_DATABASE_URL` verildiyse); `last_source_time` kopyalanan en yeni işlem güncellemesi. Bağlanamazsa `last_error` sebebi söyler.
- Sağlıklı bir satırda (`consecutive_failures` 0) `last_error` doluysa, o geçmişte görülmüş son hatadır; `last_error_at` ne zaman olduğunu söyler.
- `axi:*` satırlarında `last_source_time` o dilimin son kapanmış mumunun açılışı. Örneğin 1d için dünün 21:00 UTC'si (İstanbul 00:00): bugünün günlük mumu henüz oluşuyor.
