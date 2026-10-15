# core servisi (Railway)

core, collector'ın yazdığı ham verilerden hesaplanan değerleri üretip aynı Postgres'e yazan ikinci süreç. Şimdilik Axi mumlarının göstergelerini hesaplıyor: ZLEMA bölgesi, RSI 14 ve ATR 14. Bunlar 15m, 1h, 4h ve 1d dilimlerinde her kapanmış mum için `axi_indicators` tablosuna yazılıyor. L/S açıları ve heatmap cluster'ları sonraki PR'larla gelecek.

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

Başka değişken gerekmiyor; core dış servislere bağlanmıyor. `Postgres` yerine kanvastaki Postgres servisinin adı yazılır (`${{` yazınca açılan listeden seçmek en güvenlisi).

## 4. İlk açılışta beklenenler

```
şema güncel, uygulanacak migration yok
[core] başladı
[core] 15m: ... mum hesaplandı, ... satır yazıldı
[core] 1h: ... mum hesaplandı, ... satır yazıldı
[core] 4h: ... mum hesaplandı, ... satır yazıldı
[core] 1d: ... mum hesaplandı, ... satır yazıldı
```

- `003_gostergeler.sql` migration'ını hangi servis önce açılırsa o uygular. Bu PR `packages/db`'yi değiştirdiği için collector da yeniden başlar ve büyük ihtimalle 003'ü o uygular (`uygulandı: 003_gostergeler.sql`); core sonra açılınca "şema güncel" yazar.
- İlk hesap bütün geçmişi birkaç saniyede bitirir. Sonra dakikada bir (saniye 20, collector'ın mum turundan sonra) yeni ya da düzeltilmiş mumlar işlenir; tek mumluk güncellemelerde log satırı düşmez.
- collector bir mumu düzeltirse ya da boşluk denetimi araya mum eklerse, o mumdan sonrası yeniden hesaplanır ve yalnız değişen satırlar yazılır (`[core] 1h: 643 mum hesaplandı, 455 satır yazıldı` gibi).
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

-- sağlık
SELECT source, last_success_at, last_source_time, consecutive_failures, last_error
FROM collector_status WHERE source LIKE 'core:%' ORDER BY source;
```

- `core:*` satırlarında `last_source_time`, o dilimde göstergesi hesaplanmış son mumun açılışı. collector'ın aynı dilimdeki `axi:*` satırıyla aynı olmalı; en çok bir dakika geride kalabilir.
- Hata görürsen `last_error` sebebi söyler; bir sonraki dakika yeniden dener.
