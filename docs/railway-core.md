# core servisi (Railway)

core, collector'ın yazdığı ham verilerden hesaplanan değerleri üretip aynı Postgres'e yazan ikinci süreç. Beş hesap yapıyor:

- **Axi göstergeleri** (`axi_indicators`): ZLEMA bölgesi, RSI 14 ve ATR 14; 15m, 1h, 4h ve 1d dilimlerinde her kapanmış mum için.
- **Destek/direnç bölgeleri** (`sr_zones`, `sr_zone_events`): Axi 4h ve 1d mumlarından; her bölgenin belirdiği ve bittiği an, sabit bandı, gücü, hangi dilimlerden geldiği, olayları (test, tuttu, kırıldı) ve ekranda gösterilip gösterilmediği. Her 4h kapanışında.
- **Heatmap seviyeleri** (`heatmap_levels`): her heatmap snapshot'ı (12h, 24h, 48h) için her yönde en çok 3 cluster, %1/2/3 bant likiditesi ve heatmap fiyatı ile Axi fiyatı arasındaki baz.
- **L/S açıları** (`lsr_angles`): global ve TT pozisyon oranı için 5m, 15m, 1h ve 4h dilimlerinde serinin her noktasında açı.
- **Naif kural kararları** (`naive_decisions`): eski sistemin naif kuralının yeni sistemin verisiyle yeniden oynatılması ve ileri izlemesi (doğrulama). 18 Eylül'den bu yana her 12h snapshot'ında karar ve sinyalse Axi 1m mumlarıyla benzetilen işlem.

collector'la aynı repodan ikinci bir servis: kod aynı, başlatma komutu ve izlenen yollar farklı. Böylece core'a gelen bir değişiklik collector'ı yeniden başlatmaz, core'daki bir hata da veri toplamayı durdurmaz. İkisi aynı Postgres'i kullanır.

## 1. Servisi aç

Aynı projede New → GitHub Repo → `ariagdere/paraleltrading` (collector'ı açtığın repo). Railway aynı repodan yeni bir servis açar; adını `core` yap.

- Railway monorepo'daki paketler için birden çok servis önerirse yalnız birini bırak.
- Servis ayarlar girilmeden ilk kez deploy olursa `No start command detected` ile düşer; bu normal, aşağıdaki ayarları girince yeniden deploy et.

## 2. Ayarlar (Settings)

| Ayar | Değer |
|---|---|
| Root Directory | boş (repo kökü) |
| Branch | `main` |
| Builder | Railpack (varsayılan) |
| Build Command | boş |
| Start Command | `node --import tsx apps/core/src/index.ts` |
| Watch Paths | `/apps/core/**`, `/packages/db/**`, `/package.json`, `/package-lock.json` |
| Restart Policy | Always |
| Region | collector'la aynı |
| Replicas | 1 |
| Public Networking | gerekmez (servisin HTTP ucu yok) |

Start Command'in npm üzerinden değil doğrudan node ile olması collector'daki sebeple: npm kapanma sinyalini sürece iletmiyor.

## 3. Değişkenler (Variables)

| Değişken | Değer |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `NAIVE_FROM` | İsteğe bağlı: naif kararların başladığı an; varsayılan `2026-09-18T00:00:00Z` |

Başka değişken gerekmiyor; core dış servislere bağlanmıyor. `Postgres` yerine kanvastaki Postgres servisinin adı yazılır (`${{` yazınca açılan listeden seçmek en güvenlisi).

## 4. İlk açılışta beklenenler

```
şema güncel, uygulanacak migration yok
[core] başladı
[core] 15m: ... mum hesaplandı, ... satır yazıldı
[core] 1h: ... mum hesaplandı, ... satır yazıldı
[core] 4h: ... mum hesaplandı, ... satır yazıldı
[core] 1d: ... mum hesaplandı, ... satır yazıldı
[core] destek/direnç: ... bölge (... geçerli); ... bölge, ... olay yazıldı, 0 silindi
[core] heatmap: ... snapshot hesaplandı
[core] L/S açıları (global): ... satır yazıldı
[core] L/S açıları (top_position): ... satır yazıldı
[core] naif: ... karar (... sinyal, ... açık işlem); ... satır yazıldı, 0 silindi
```

- Yeni bir migration'ı (ör. `006_destek_direnc.sql`) hangi servis önce açılırsa o uygular. `packages/db`'yi değiştiren bir merge collector'ı, core'u ve web'i birlikte yeniden başlatır; migration'ı büyük ihtimalle collector uygular (`uygulandı: 006_destek_direnc.sql`), core sonra açılınca "şema güncel" yazar. Heatmap turuna denk gelmesin diye böyle merge'leri xx:00–xx:06 dışında yap.
- İlk hesap bütün geçmişi birkaç saniyede bitirir. Sonra dakikada bir (saniye 20, collector'ın mum turundan sonra) yeni ya da düzeltilmiş mumlar işlenir; tek mumluk güncellemelerde log satırı düşmez.
- collector bir mumu düzeltirse ya da boşluk denetimi araya mum eklerse, o mumdan sonrası yeniden hesaplanır ve yalnız değişen satırlar yazılır (`[core] 1h: 643 mum hesaplandı, 455 satır yazıldı` gibi).
- Destek/direnç ilk açılışta bütün 4h geçmişini (Nisan'dan) baştan oynatır, bir saniye kadar sürer. Sonra her yeni 4h ya da 1d kapanışında (günde 6 kez) ve bu dilimlerde bir mum düzeltilince ya da araya eklenince yeniden oynatır; yalnız değişen satırları yazar (her 4h kapanışında geçerli bölgelerin puanı ve yeni olaylar, birkaç on satır).
- Heatmap seviyeleri ilk açılışta bütün snapshot'lar için hesaplanır: eski sistemden kopyalanan 12h'ler ve collector'ın yazdıkları (yaklaşık 900). Sonra her yeni snapshot bir sonraki dakika işlenir.
- L/S açıları ilk açılışta bütün seri için hesaplanır (metrik başına ~18 bin satır, bir saniye kadar). Sonra yeni 5m noktası geldikçe (5 dakikada bir) yalnız yeni satırlar yazılır.
- Naif kararlar ilk açılışta 18 Eylül'den bu yana bütün 12h snapshot'ları için hesaplanır (eski sistemden kopyalananlar ve collector'ın saatlik 12h'leri; birkaç saniye). Sonra her turda girdilerden biri değişince (yeni 1m mumu, yeni snapshot ya da seviye) baştan hesaplanır, yalnız değişen satırlar yazılır: yeni snapshot gelince ya da açık bir işlem kapanınca log satırı düşer.
- Beklenmeyen biçimde bir snapshot olursa `[core] heatmap 123 (12h): seviye çıkmadı` yazar; o snapshot boş satırla işaretlenir, yeniden denenmez.
- Deploy sırasında eski süreç kapanana kadar yenisi `başka bir core çalışıyor; kilit bekleniyor` yazar.

## 5. Hesaplar

| Sütun | Hesap |
|---|---|
| `zlema_fast`, `zlema_slow`, `zlema_zone` | Eski sistemin formülü (hakari-trigger-orchestrator): hlc3 → Kalman → ZLEMA(8) ve ZLEMA(21). LONG: hızlı > yavaş ve hızlı son iki mumdur yükseliyor; SHORT: tersi; değilse NO_TRADE |
| `rsi14` | RSI 14, Wilder ortalaması (TradingView'deki gibi) |
| `atr14` | ATR 14, Wilder ortalaması (TradingView'deki gibi) |

- Eski sistem her hesapta son 150 mumu kullanıyordu. Kalman'ın başlangıç değeri yüzünden sonuç pencereye bağlı, bu yüzden her mumun ZLEMA'sı o muma kadarki son 150 mumla hesaplanıyor. Aynı 150 mumla eski kod ve core birebir aynı sonucu veriyor.
- Değer mum kapanınca bilinir. 4h mumu İstanbul 16:00'da açıldıysa değeri 20:00'de kesinleşir.
- Eski sistem 4h bölgesini Binance mumlarıyla ve oluşan (henüz kapanmamış) mumu da katarak hesaplıyordu. Oluşan mumlu değer saklanmaz; geriye dönük simülasyon aynı fonksiyonla 1m mumlardan hesaplayacak.
- İlk 149 mumda ZLEMA, ilk 14 mumda RSI, ilk 13 mumda ATR boş. Collector her dilimde 18 Eylül'den 1000 mum öncesine kadar indiği için 18 Eylül'den itibaren hepsi dolu.

### Destek/direnç bölgeleri (`sr_zones`, `sr_zone_events`)

Bölge, fiyatın birçok kez döndüğü ya da kapandığı fiyat aralığı. Hesap 4h kapanışlarında ve yalnız o ana kadar bilinenle yapılır; bölgenin belirme ve bitiş anı da, olayların anı da o anda bilinen bir 4h kapanışı. Sürüm `v3` (16 Ekim).

- **İzler:**
  - 4h dönüş noktaları: iki yanında 2 mum daha uç değil ve 12 mum içinde en az 1 ATR(4h) tepki var. Fiyat dönüşten 1 ATR uzaklaştığı 4h kapanışında bilinir, en erken iki mum sonra. Ağırlık 1.
  - Günlük tepe, dip ve kapanış: ağırlık her biri 0,5, gün kapanışında.
  - Haftalık tepe, dip ve kapanış: ağırlık her biri 1,5, hafta kapanışında. Hafta pazartesi 00:00 İstanbul'da başlar.
  - İzler yarı ömürle zayıflar: 4h'de 21 gün, günlükte 30 gün, haftalıkta 120 gün.
- **Bölge:** izlerin fiyat ekseninde yoğunlaştığı yer (her iz 0,10 ATR genişliğinde bir çan eğrisi). Bant tepenin %60'ına kadar uzanır, yarı genişlik 0,08–0,5 ATR. **Bant belirdiği anda belirlenir ve bir daha değişmez.** Güç, kendi bandındaki izlerin o anki ağırlıkları toplamı.
- **Yaşam:**
  - Yeni bölge güç ≥ 3 ile açılır; iki bölgenin merkezleri arasında en az 0,8 ATR olur.
  - Bölge, kendi bandının gücü 2'nin altına inince (`izler zayıfladı`) ya da daha güçlü bir bölgeyle örtüşünce biter.
  - Kırılma bölgeyi bitirmez, rolünü çevirir: destek dirence döner.
- **Gösterilecekler:** her 4h kapanışında, fiyatın ±%5'inde üstte ve altta en güçlü 3 bölge ve fiyatın içinde olduğu bölge. Gösterilen bir bölgenin yerine ancak iki kat güçlü bir bölge geçer; böylece küme her kapanışta yer değiştirmez (gösterilen kümeye günde ortalama 2 bölge girip çıkıyor).

| Tablo | İçerik |
|---|---|
| `sr_zones` | Bölgenin son durumu: `created_at` (belirdiği an), `ended_at` (sürüyorsa boş), `end_reason`, bant `lo`–`hi`, `score` (güç) ve dilimlere dağılımı (`score_4h`, `score_1d`, `score_1w`), `touches`, `holds`, `breaks`, `shown` (şu an gösterilenlerden), güç geçmişi (`score_at`, `score_value`: belirince ve %15'ten çok değişince) |
| `sr_zone_events` | Olaylar sırayla (`seq`): `created`; `touch` (en az 0,6 ATR uzaktan gelip banda girdi); `hold` (testten sonra aynı yana 1 ATR uzaklaştı); `break` (bandın 0,15 ATR ötesinde kapandı); `shown` ve `hidden` (gösterilenlere girdi, çıktı); `ended`. Her olayda o anki fiyat, bant ve güç |
| `sr_versions` | Algoritma ve parametre sürümü ve parametreleri |

- v2'nin satırları (bant zamanla değişiyordu, `resized` olayları) olduğu gibi duruyor; web en yeni sürümü okur.
- Algoritma ya da parametre değişince yeni sürüm açılır. Eski sürümün satırları olduğu gibi kalır.
- Prototip, v2 teşhisi ve v3 ölçümleri: proje dokümanı "Destek/direnç bölgeleri — prototip ve kararlar".

### Heatmap seviyeleri (`heatmap_levels`)

Her snapshot için bir satır; değer snapshot'ın `received_at` anında bilinir.

| Sütun | Hesap |
|---|---|
| `ref_price` | Heatmap'in referans fiyatı: son fiyat mumunun kapanışı (eski sistemle aynı) |
| `up1_price`, `up1_usd` … `up3_*` | Referansın üstündeki cluster'lar. Her seviyenin bütün sütunlardaki likidite toplamı alınır, $1M altı dışarıda kalır. En büyük seviye ve onun ±$300'ündeki seviyeler bir cluster: fiyatı likiditeyle ağırlıklı ortalama, likiditesi toplam. `up1` eski sistemin cluster'ının aynısı; `up2` ve `up3` aynı kuralın kalan seviyelerde tekrarı |
| `dn1_*` … `dn3_*` | Referansın altındaki cluster'lar, aynı kural |
| `up_liq_1pct`, `_2pct`, `_3pct` | Referansın %1, %2, %3 yukarısına kadarki bütün seviyelerin likidite toplamı ($1M altı da) |
| `dn_liq_*` | Aynısı aşağı yönde |
| `axi_price` | O anki Axi fiyatı: snapshot'ın güncellenme anına kadar kapanmış son Axi 1m mumunun kapanışı (bid) |
| `basis` | `ref_price − axi_price`. Heatmap fiyatıyla bulunan bir seviye Axi'de `seviye − basis` |

- Eski sistem cluster değerlerini iki ondalığa yuvarlayıp kullanıyordu; burada yuvarlanmadan saklanıyor.
- 2. ve 3. cluster tepe seviyesine göre sıralı. Çok seviyeli bir kümenin toplamı tek büyük seviyeden oluşan 1. cluster'ınkini geçebilir.
- Axi 1m mumu o an yoksa (MetaApi geç verdiyse) `axi_price` ve `basis` boş kalır; son bir günün satırlarında mum gelince doldurulur. Axi 1m serisi 17 Eylül'de başladığı için eski sistemden kopyalanan daha eski 12h'lerde baz yok.

### L/S açıları (`lsr_angles`)

Formül eski sistemin (hakari-lsr-refresher `lsrAngle.js`); her metrik (`global`, `top_position`) ve dilim için serinin her noktasında biten 30 noktalık pencere:

| Sütun | Hesap |
|---|---|
| `slope` | Pencerenin ortalamaya göre normalize değerlerine x = 0…1 doğrusu oturtulur; eğim pencere boyunca toplam normalize değişim |
| `r2` | Uyumun güvenilirliği (0–1) |
| `ref`, `n_ref` | O noktaya kadarki bütün geçerli pencerelerin \|eğim\| değerlerinin %90'lık değeri ve pencere sayısı |
| `angle` | atan(slope / ref), derece. `n_ref` 100'den azsa ya da pencerede eksik nokta varsa boş |

- 15m, 1h ve 4h serileri 5m serisinden alınıyor: dilim sınırındaki (UTC) 5m noktaları. Binance'in 1h noktası aynı andaki 5m noktasıyla birebir aynı (eski verideki 1.030 saatin hepsi).
- Referans serinin başından bütün pencerelere bağlı. Seri 30 Ağustos'ta başladığı için ilk açı 5m'de ~11 saat, 15m'de ~32 saat, 1h'de ~5 gün, 4h'de ~21 gün sonra; 18 Eylül'den sonra dört dilimde de açı var.
- Eski sistem `t` anındaki açıyı ts ≤ t − dilim olan son noktadan alıyordu (lag 1). O nokta t − dilim'den iki dilim ya da daha eskiyse açı yok sayılıyordu. Aşağıdaki sorgu bunu yapıyor.

### Naif kural kararları (`naive_decisions`)

Eski sistemin naif kuralı (hakari-trigger-orchestrator) birebir; tek fark ZLEMA 4h bölgesinin kaynağı: eski sistem Binance vadeli 4h, core Axi 4h. Her 12h heatmap snapshot'ı için bir satır, sürüm `v1`. Gerçek naif işlemlerle (eski sistemin magic 7575 emirleri, `legacy_orders`) karşılaştırma web'in Doğrulama sayfasında.

| Sütun | Hesap |
|---|---|
| `cycle_at`, `decided_at` | Döngü anı: heatmap'in son sütunu. Karar anı: döngü + 45 sn (eski sistemde heatmap'ten emre ölçülen medyan gecikme) |
| `ref_price`, `up_price`, `dn_price`, `basis` | Snapshot'ın seviyeleri (`heatmap_levels`): referans fiyat ve iki yandaki 1. cluster |
| `direction`, `entry_ref`, `tp`, `sl`, `rr` | Setup: yakın cluster'ın yönü; TP yakın cluster'a mesafenin %75'i, SL uzak cluster'a mesafenin %75'i. İki ondalık ve heatmap fiyatıyla: eski sistem emri bu fiyatlarla gönderiyordu |
| `zone_4h`, `aligned` | Karar anındaki ZLEMA 4h bölgesi: Axi 4h'nin son 149 kapanmış mumu ve oluşan mum (karar anına kadar kapanmış 1m mumlarından). Yön bölgeyle aynıysa `aligned` |
| `in_window` | Eski sistemin o tarihteki penceresi: 9 Ekim 15:40'a kadar hafta içi (bütün gün), sonra pazartesi 00:00 – cuma 15:05 (İstanbul, döngü anına göre) |
| `signal`, `reason` | Hizalı ve penceredeyse sinyal: eski sistem emir gönderirdi. Değilse neden: `seviye_yok`, `cluster_yok`, `bolge_yok`, `bolge_farkli`, `pencere_disi`. Sinyal benzetilemediyse `fiyat_yok` (karar anında Axi mumu yok) ya da `gecersiz_seviye` (TP ya da SL Axi fiyatının yanlış tarafında) |
| `entry_bid`, `entry_price`, `spread` | Karar anını içeren Axi 1m mumunun açılışı (bid). BUY ask'tan (bid + spread), SELL bid'den girer. Spread mumun `spread_points` × point'i; mumda yoksa 12 $ |
| `exit_at`, `exit_reason`, `exit_price` | Sonraki 1m mumlarında ilk dokunan seviye; BUY bid'le, SELL ask'la çıkar. Mum seviyenin ötesinde açılırsa açılıştan çıkar; TP ve SL aynı mumdaysa SL sayılır (`ambiguous`). Açık işlemde boş |
| `r_multiple`, `mfe`, `mae` | R girişe ve SL'e göre; girişten en iyi ve en kötü hareket ($) |

- Her karar yalnız karar anına kadar bilinenle verilir; işlem sonraki mumlarla ilerler.
- collector'ın ilk snapshot'ına kadarki 12h'ler eski döngülerin kendisi (eski sistemden kopyalanan, aynı Apify çalıştırması): yeniden oynatma. Sonrası collector'ın saatlik 12h snapshot'ları: ileri izleme.
- Bir 1m mumu sonradan düzelirse ya da araya eklenirse geçmişteki işlemler de düzelir. Tablo elle silinirse core bir sonraki turda yeniden yazar.
- Kural ya da parametre değişince yeni sürüm açılır (`v2`); eski sürümün satırları olduğu gibi kalır.
- Ön izleme ve kararlar: proje dokümanı "Naif kural doğrulaması".

## 6. DBeaver'da kontrol

```sql
-- dilim başına son göstergeler (İstanbul saati)
SELECT timeframe, open_time AT TIME ZONE 'Europe/Istanbul' AS acilis, zlema_zone,
       round(zlema_fast::numeric, 2) AS hizli, round(zlema_slow::numeric, 2) AS yavas,
       round(rsi14::numeric, 1) AS rsi, round(atr14::numeric, 1) AS atr
FROM axi_indicators i
WHERE open_time = (SELECT max(open_time) FROM axi_indicators WHERE timeframe = i.timeframe)
ORDER BY timeframe;

-- son 4h bölgeleri
SELECT open_time AT TIME ZONE 'Europe/Istanbul' AS acilis, zlema_zone, round(rsi14::numeric, 1) AS rsi
FROM axi_indicators WHERE timeframe = '4h' ORDER BY open_time DESC LIMIT 12;

-- gösterilen destek/direnç bölgeleri, yukarıdan aşağı (İstanbul saati); shown koşulunu kaldırınca bütün geçerliler
SELECT zone_id, round(lo::numeric) AS alt, round(hi::numeric) AS ust, round(score::numeric, 1) AS guc,
       round(score_4h::numeric, 1) AS g4h, round(score_1d::numeric, 1) AS g1d, round(score_1w::numeric, 1) AS g1w,
       created_at AT TIME ZONE 'Europe/Istanbul' AS belirdi, touches AS test, holds AS tuttu, breaks AS kirildi
FROM sr_zones WHERE version = 'v3' AND ended_at IS NULL AND shown ORDER BY hi DESC;

-- son destek/direnç olayları
SELECT e.at AT TIME ZONE 'Europe/Istanbul' AS an, e.zone_id, e.kind, round(e.price::numeric) AS fiyat,
       round(e.lo::numeric) AS alt, round(e.hi::numeric) AS ust, e.note
FROM sr_zone_events e WHERE e.version = 'v3' ORDER BY e.at DESC, e.zone_id, e.seq DESC LIMIT 20;

-- bir anda gösterilen bölgeler (bant sabit): örnek 12 Ekim 16:00 İstanbul
SELECT z.zone_id, round(z.lo::numeric) AS alt, round(z.hi::numeric) AS ust, round(e.score::numeric, 1) AS gosterildigindeki_guc
FROM sr_zones z
JOIN LATERAL (SELECT kind, score FROM sr_zone_events
              WHERE symbol = z.symbol AND version = z.version AND zone_id = z.zone_id AND kind IN ('shown', 'hidden', 'ended')
                AND at <= timestamptz '2026-10-12 16:00+03'
              ORDER BY seq DESC LIMIT 1) e ON e.kind = 'shown'
WHERE z.version = 'v3'
ORDER BY z.hi DESC;

-- son heatmap seviyeleri (İstanbul saati)
SELECT l.span, l.received_at AT TIME ZONE 'Europe/Istanbul' AS geldi, round(l.ref_price::numeric) AS ref,
       round(l.basis::numeric, 1) AS baz, round(l.up1_price::numeric) AS ust, round((l.up1_usd / 1e6)::numeric, 1) AS ust_m,
       round(l.dn1_price::numeric) AS alt, round((l.dn1_usd / 1e6)::numeric, 1) AS alt_m
FROM heatmap_levels l ORDER BY l.snapshot_id DESC LIMIT 6;

-- son L/S açıları (İstanbul saati)
SELECT metric, period, ts AT TIME ZONE 'Europe/Istanbul' AS nokta, round(angle::numeric, 1) AS aci, round(r2::numeric, 2) AS r2
FROM lsr_angles a
WHERE ts = (SELECT max(ts) FROM lsr_angles WHERE metric = a.metric AND period = a.period)
ORDER BY metric, period;

-- eski sistemin bir andaki açısı (lag 1): örnek 1h global, 16 Ekim 10:30 İstanbul
SELECT round(angle::numeric, 2) AS aci FROM lsr_angles
WHERE metric = 'global' AND period = '1h'
  AND ts <= timestamptz '2026-10-16 10:30+03' - interval '1 hour'
  AND ts > timestamptz '2026-10-16 10:30+03' - interval '1 hour' - interval '2 hours'
ORDER BY ts DESC LIMIT 1;

-- son naif kararlar (İstanbul saati)
SELECT cycle_at AT TIME ZONE 'Europe/Istanbul' AS dongu, direction AS yon, zone_4h AS bolge, signal AS sinyal, reason AS neden,
       round(tp::numeric) AS tp, round(sl::numeric) AS sl, round(entry_price::numeric) AS giris, exit_reason AS cikis,
       round(r_multiple::numeric, 2) AS r
FROM naive_decisions WHERE version = 'v1' ORDER BY cycle_at DESC LIMIT 12;

-- naif sinyaller ve sonuçları, gün gün (İstanbul)
SELECT (cycle_at AT TIME ZONE 'Europe/Istanbul')::date AS gun, count(*) AS karar, count(*) FILTER (WHERE signal) AS sinyal,
       count(*) FILTER (WHERE exit_reason = 'TP') AS tp, count(*) FILTER (WHERE exit_reason = 'SL') AS sl,
       count(*) FILTER (WHERE entry_price IS NOT NULL AND exit_reason IS NULL) AS acik, round(sum(r_multiple)::numeric, 2) AS r
FROM naive_decisions WHERE version = 'v1' GROUP BY 1 ORDER BY 1 DESC;

-- sinyal olmayan kararların nedenleri
SELECT reason AS neden, count(*) AS adet FROM naive_decisions WHERE version = 'v1' AND NOT signal GROUP BY 1 ORDER BY 2 DESC;

-- gerçek naif işlemler ve aynı Apify çalıştırmasındaki karar (eşleşmeyenlerde karar boş)
SELECT o.opened_at AT TIME ZONE 'Europe/Istanbul' AS acilis, o.direction AS yon, o.data->>'exit_reason' AS gercek_cikis,
       d.signal AS sinyal, d.reason AS neden, d.exit_reason AS benzetim_cikis
FROM legacy_orders o
LEFT JOIN heatmap_snapshots s ON s.apify_run_id = o.data->>'apify_run_id'
LEFT JOIN naive_decisions d ON d.snapshot_id = s.id AND d.version = 'v1'
WHERE o.magic = 7575 ORDER BY o.opened_at DESC LIMIT 20;

-- sağlık
SELECT source, last_success_at, last_source_time, consecutive_failures, last_error
FROM collector_status WHERE source LIKE 'core:%' ORDER BY source;
```

- `core:15m` … `core:1d` satırlarında `last_source_time`, o dilimde göstergesi hesaplanmış son mumun açılışı. collector'ın aynı dilimdeki `axi:*` satırıyla aynı olmalı; en çok bir dakika geride kalabilir.
- `core:sr` satırında `last_source_time`, bölgeleri hesaplanmış son 4h mumunun açılışı; `axi:4h` satırıyla aynı olmalı (en çok bir dakika geride).
- `core:heatmap` satırında `last_source_time`, seviyesi hesaplanmış son snapshot'ın `received_at`'i.
- `core:lsr` satırında `last_source_time`, açısı hesaplanmış son L/S noktası; collector'ın `lsr:*` satırlarıyla aynı olmalı (en çok bir dakika geride).
- `core:naif` satırında `last_source_time`, kararı verilmiş son 12h döngüsü (heatmap'in son sütunu); saatte bir ilerler.
- Hata görürsen `last_error` sebebi söyler; bir sonraki dakika yeniden dener.
