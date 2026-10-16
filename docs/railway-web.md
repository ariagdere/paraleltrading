# web servisi (Railway)

web, Hakari 2'nin tarayıcıdan açılan yüzü. İki sayfa var:

- **Piyasa** (girişten sonra açılan sayfa): Axi BTCUSD fiyatı; tek temel grafik ve düğmeyle açılıp kapanan katmanlar (likidasyon heatmap'i, cluster'lar, destek/direnç bölgeleri, önceki gün/hafta seviyeleri); ZLEMA/RSI/ATR, Long/Short oranı ve açıları, günlük bias.
- **Sağlık**: her veri kaynağının son verisinin ne zaman geldiği, sıradakinin ne zaman beklendiği, gecikenler ve hatalar.

collector ve core'la aynı repodan üçüncü bir servis. Veritabanına yalnız okumak için bağlanır: oturumlar salt okunur açılır (`default_transaction_read_only`), web hiçbir tabloya yazamaz. Kullanıcı adı ve şifre Railway değişkenlerinde; giriş yapılmadan hiçbir sayfa ve veri açılmaz.

## 1. Servisi aç

Aynı projede New → GitHub Repo → `ariagdere/paraleltrading`. Yeni servisin adını `web` yap.

- Railway monorepo'daki paketler için birden çok servis önerirse yalnız birini bırak.
- Ayarlar girilmeden ilk deploy düşerse normal; aşağıdaki ayarları girip yeniden deploy et.

## 2. Ayarlar (Settings)

| Ayar | Değer |
|---|---|
| Root Directory | boş (repo kökü) |
| Branch | `main` |
| Builder | Railpack (varsayılan) |
| Build Command | `npm run build -w @pt/web` |
| Start Command | `node node_modules/next/dist/bin/next start apps/web` |
| Watch Paths | `/apps/web/**`, `/packages/db/**`, `/package.json`, `/package-lock.json` |
| Healthcheck Path | `/api/health` |
| Restart Policy | Always |
| Region | collector'la aynı |
| Replicas | 1 |

- Start Command npm üzerinden değil doğrudan node ile: npm kapanma sinyalini sürece iletmiyor.
- Sunucu Railway'in verdiği `PORT`'u dinler; ayrıca port ayarı gerekmez.

## 3. Değişkenler (Variables)

| Değişken | Değer |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `WEB_USER` | giriş kullanıcı adı (istediğin bir ad) |
| `WEB_PASSWORD` | giriş şifresi (uzun ve başka yerde kullanmadığın bir şifre) |
| `WEB_SESSION_SECRET` | oturum imzası için uzun rastgele bir değer (parola yöneticisinden 40+ karakter) |

- `WEB_USER` ya da `WEB_PASSWORD` yoksa hiçbir sayfa açılmaz; giriş sayfası hangi değişkenin eksik olduğunu yazar.
- `WEB_SESSION_SECRET` yoksa imza için `DATABASE_URL` kullanılır; çalışır ama ayrı bir değer daha iyi.
- Şifreyi ya da `WEB_SESSION_SECRET`'ı değiştirmek bütün açık oturumları kapatır (yeniden giriş gerekir).

## 4. Adres (Networking)

Settings → Networking → Public Networking → Generate Domain. Railway `web-production-xxxx.up.railway.app` gibi bir adres verir; sayfa bu adreste açılır. İstersen sonra kendi alan adını bağlayabilirsin (Custom Domain).

## 5. İlk açılışta beklenenler

Build loglarında:

```
▲ Next.js 16.4.2 (Turbopack)
✓ Compiled successfully
  Finished TypeScript ...
Route (app)
├ ƒ /api/piyasa/bolgeler
├ ƒ /api/piyasa/heatmap
├ ƒ /api/piyasa/mumlar
├ ƒ /login
├ ƒ /piyasa
└ ƒ /saglik
ƒ Proxy (Middleware)
```

Deploy loglarında:

```
▲ Next.js 16.4.2
✓ Ready in ...
```

Adresi açınca giriş sayfası gelir. Girişten sonra Piyasa sayfası açılır; loglara `[web] giriş yapıldı (IP)` düşer. Hatalı denemeler `[web] giriş: hatalı (IP, 3/10)` olarak görünür.

- Yalnız `apps/web`'i değiştiren bir merge yalnız web'i yeniden deploy eder; collector ve core çalışmaya devam eder.
- `packages/db`'yi ya da `package-lock.json`'u değiştiren bir merge collector ve core'u da yeniden başlatır. Heatmap turuna denk gelmesin diye böyle merge'leri xx:00–xx:06 dışında yap.

## 6. Giriş ve oturum

- Oturum imzalı bir çerezde (`hakari2_session`); sunucuda oturum tablosu yok. 30 gün geçerli, kullandıkça uzar; girişten 90 gün sonra yeniden giriş istenir.
- Aynı IP'den 15 dakikada 10 hatalı denemede o IP 15 dakika kilitlenir (servis yeniden başlayınca sayaç sıfırlanır).
- Başka bir siteden gönderilen form ve yazan istekler reddedilir.
- Menüdeki "Çıkış yap" çerezi siler.

## 7. Piyasa sayfası

Sayfa dakikada bir kendini yeniler (sekme arka plandaysa yenilemez). Bütün saatler İstanbul saati; fiyatlar Axi BTCUSD.

- **Üst satır:** son 1m mumunun kapanışı, dünkü günlük kapanıştan değişim; baz (en yeni 24h heatmap'te CoinGlass ile Axi fiyat farkı), ATR 4h, günlük bias.
- **Grafik:** tek temel grafik, Axi mumları. Dilim düğmeleri 5m, 15m, 1h, 4h, 1d (açılışta 15m).
  - Sürükleyerek geçmişe kaydırılır, tekerlekle yakınlaştırılır, fiyat ekseni sürüklenerek dikeyde ölçeklenir. Sola kaydırdıkça daha eski mumlar okunur.
  - Beyaz etiketli çizgi son 1m kapanışı.
  - İmleç mumun açılış, tepe, dip ve kapanışını, imlecin fiyatını, altındaki heatmap hücresinin likidasyonunu ve imleç bir bölgenin içindeyse o bölgeyi gösterir.
- **Katman düğmeleri** (aynı zamanda lejant; seçimler, dilim ve heatmap penceresi tarayıcıda hatırlanır):
  - **Heatmap:** CoinGlass model1 likidasyon seviyeleri mumların arkasında; koyuluk o fiyattaki likidasyon miktarı, kesik dikey çizgi heatmap'in alındığı an. Sağ kenardaki gri çubuklar fiyat seviyesine göre toplam likidasyon (profil); heatmap'in kapsamadığı uzun aralıklarda da görünür. Heatmap ve cluster'lar baz kadar kaydırılır, yani Axi fiyatıyla çizilir; snapshot anına ait Axi mumu yoksa CoinGlass fiyatıyla çizilir ve altta yazar.
  - **Cluster'lar:** core'un `heatmap_levels` tablosundan, fiyatın üstünde ve altında en çok üçer çizgi. Numara core'daki sıra: 1 eski sistemin kullandığı en büyük cluster (düz çizgi), 2 ve 3 aynı kuralın kalan seviyelerde tekrarı (kesik). Grafiğin sağ ucu görünürken fiyat ekseni fiyatın %6'sından yakın en yakın cluster'ları da kapsar.
  - **Destek/direnç:** yalnız core'un gösterdiği bölgeler: fiyatın ±%5'inde, üstte ve altta en güçlü 3 ve fiyatın içinde olduğu bölge. Her biri belirdiği andan sağ kenara sabit bir mor bant; sağda gücü yazar (heatmap açıksa profilin solunda). Seçim her 4h kapanışında yenilenir; gösterilen bir bölgenin yerine ancak iki kat güçlü bir bölge geçer.
  - **Önceki gün/hafta:** dünün tepe ve dibi (pdh, pdl), geçen haftanın tepe, dip, açılış ve kapanışı (pwh, pwl, pwo, pwc); kesik çizgiler. Gün 00:00'da, hafta pazartesi 00:00'da (İstanbul) başlar.
- **Heatmap penceresi** (heatmap ya da cluster katmanı açıkken): 12h, 24h, 48h (açılışta 24h). ‹ ve › bir önceki ve sonraki snapshot'a gider; "En yeni" yeniden en yeni snapshot'ı izler. En yeni izlenirken dakikalık yenileme o pencerenin yeni snapshot'ını getirir; eski bir snapshot açıkken grafik yerinde kalır.
- **Grafiğin altında** yalnız açık katmanların ayrıntısı: gösterilen bölgeler yukarıdan aşağı, aralarında fiyat (bant, uzaklık, güç, kaynak: gücün çoğunun geldiği dilim, test, tuttu, kırıldı, belirdiği gün); cluster'lar ve bant likiditesi (referansın %1, %2 ve %3 altı ve üstü); önceki gün ve hafta seviyeleri.
- **Yan sütun:** ZLEMA, RSI ve ATR (15m, 1h, 4h ve 1d'nin kapanmış son mumu, `axi_indicators`); Long/Short (Binance global ve top trader oranı, 5m–4h açıları); günlük bias (son rapor: yön, güven, net yön, skor, sonuç metni).
- Grafik kütüphanesi TradingView Lightweight Charts (Apache 2.0); lisans gereği grafiğin köşesinde TradingView logosu ve sayfada atıf var.

Grafik verisini API verir; uçlar giriş ister ve önbelleğe alınmaz:

| Uç | Ne verir |
|---|---|
| `/api/piyasa/mumlar?tf=1h[&before=<ms>\|&after=<ms>][&n=600]` | Axi mumları, eskiden yeniye: en yeni n, ya da bir andan önceki n (geçmişe kaydırınca), ya da bir andan sonrakiler (yeni kapanışlar). n en çok 2000 |
| `/api/piyasa/bolgeler` | core'un son sürümünün geçerli bölgeleri ve hangilerinin gösterileceği |
| `/api/piyasa/heatmap?span=24h[&id=<snapshot>]` | snapshot'ın ısı ızgarası, cluster'ları, bant likiditesi ve bazı; önceki ve sonraki snapshot |

Sayfanın dakikalık yenilemesi büyük veriyi yeniden göndermez, yalnız "değişti mi" işaretlerini taşır: yeni 1m mumu gelince grafik seçili dilimin son mumlarını, core bölgeleri yeniden hesaplayınca bölgeleri, seçili pencerede yeni snapshot olunca heatmap'i okur.

## 8. Sağlık sayfası nasıl karar veriyor

Sayfa `collector_status` ve `collector_runs` tablolarını okur, 30 saniyede bir kendini yeniler (sekme arka plandaysa yenilemez). Bütün saatler İstanbul saati.

Her kaynak için "sıradaki veri ne zaman gelmeliydi" hesaplanır. Beklenen andan sonra bir pay kadar gelmezse **gecikmeli** (sarı), iki pay geçerse **durdu** (kırmızı):

| Kaynak | Sıradaki veri | Pay |
|---|---|---|
| Axi mumları (1m–1d) ve göstergeler (15m–1d) | son mumun kapanışından bir dilim sonra | dilimin %10'u, en az 3 dk (1d'de 2,4 sa) |
| Heatmap 12h, 24h, 48h ve seviyeler | son snapshot'tan 1 saat sonra (bütçe kısınca 2 saat) | 15 dk |
| L/S global, top trader ve açılar | son noktadan 5 dk sonra | 7 dk |
| Bakım işleri: boşluk denetimi, sembol bilgisi, Apify bütçesi, eski sistem kopyası | son başarılı çalışmadan işin aralığı kadar sonra | aralığın %10'u, en az 2 dk; en çok sarı |
| Geçmiş doldurma | izlenmez, yalnız hata | en çok sarı |
| Günlük bias | hafta içi 09:07 | hafta içi 12:00'ye kadar bugünkü rapor yoksa kırmızı; öncesinde "bekleniyor", hafta sonu rapor beklenmez; okuma hatası rapor gecikmedikçe sarı |

- Kaynak hata veriyorsa (`consecutive_failures > 0`) satırda son hata ve kaç kez üst üste olduğu yazar. Veri hâlâ zamanındaysa ve hata 3 kez üst üste değilse sarı (geçici: zaman aşımı, tekrar deneniyor), değilse kırmızı.
- Göstergeler kaynağı yüzünden gecikiyorsa (Axi 15m mumu gelmiyorsa 15m göstergesi de gecikir) satırda "Kaynakta sorun var" yazar; özette yalnız kaynak sayılır.
- Son 24 saatte 3 ya da daha çok hata veren kaynakta, düzelmiş olsa da satırda hata sayısı görünür.
- "Son hatalar" tablosu son 7 günün en yeni 12 hatası (`collector_runs`'taki başarısız kayıtlar). Heatmap'te her başarısız deneme ayrı satırdır.
- Çubuk son veriden bu yana geçen süreyi gösterir: çentikte sıradaki veri beklenir, sarı bölgeye geçerse gecikmeli, sona dayanırsa durdu.

## 9. Yerelde çalıştırma

```
DATABASE_URL="<Postgres'in DATABASE_PUBLIC_URL'i>" PGSSL=true WEB_USER=ari WEB_PASSWORD=deneme \
  npm run dev -w @pt/web
```

Sonra http://localhost:3000. Yerelde çerez Secure olmadan yazılır (http); Railway'de https olduğu için Secure.
