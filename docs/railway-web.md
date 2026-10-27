# web servisi (Railway)

web, Hakari 2'nin tarayıcıdan açılan yüzü. Üç sayfa var:

- **Piyasa** (girişten sonra açılan sayfa): canlı Axi BTCUSD fiyatı; tek temel grafik (oluşan mum canlı) ve düğmeyle açılıp kapanan katmanlar (likidasyon heatmap'i, cluster'lar, destek/direnç bölgeleri, önceki gün/hafta seviyeleri); ZLEMA/RSI/ATR, Long/Short oranı, açıları ve son 30 noktanın grafikleri, günlük bias.
- **Doğrulama**: eski sistemin naif kuralının yeni sistemin verisiyle yeniden oynatılması ve ileri izlemesi; gerçek naif işlemlerle karşılaştırma.
- **Sağlık**: her veri kaynağının son verisinin ne zaman geldiği, sıradakinin ne zaman beklendiği, gecikenler ve hatalar.

collector ve core'la aynı repodan üçüncü bir servis. Veritabanına yalnız okumak için bağlanır: oturumlar salt okunur açılır (`default_transaction_read_only`), web hiçbir tabloya yazamaz. Kullanıcı adı ve şifre Railway değişkenlerinde; giriş yapılmadan hiçbir sayfa ve veri açılmaz. Canlı fiyat için MetaApi'ye tek bir streaming bağlantısı açar (yalnız BTCUSD quote'ları; işlem yapmaz, hesabı deploy etmez).

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
| `METAAPI_TOKEN` | canlı fiyat için, collector'daki gibi: `${{shared.METAAPI_TOKEN}}` |
| `METAAPI_ACCOUNT_ID` | `${{shared.METAAPI_ACCOUNT_ID}}` |
| `METAAPI_REGION` | yalnız hesap london dışındaysa (collector'da da öyle) |

- `WEB_USER` ya da `WEB_PASSWORD` yoksa hiçbir sayfa açılmaz; giriş sayfası hangi değişkenin eksik olduğunu yazar.
- `WEB_SESSION_SECRET` yoksa imza için `DATABASE_URL` kullanılır; çalışır ama ayrı bir değer daha iyi.
- Şifreyi ya da `WEB_SESSION_SECRET`'ı değiştirmek bütün açık oturumları kapatır (yeniden giriş gerekir).
- `METAAPI_TOKEN` ya da `METAAPI_ACCOUNT_ID` yoksa canlı fiyat kapalıdır: sayfa fiyatı ve oluşan mumu dakikalık 1m mumlarından gösterir, başlıkta "(canlı fiyat kapalı)" yazar.
- Canlı fiyat bağlantısı (ayrıntı 7. bölümde):
  - eski dashboard'unkiyle aynı hesaba açılır; hesap başına 10 streaming aboneliği sınırı var, bu üçüncüsü (eski sistemin monitor'ü ve dashboard'u ile);
  - streaming REST/RPC kredisi tüketmez. Quote başına 2 market data kredisi harcanır; hesabın bütçesi 10 sn'de 31.500 kredi, BTCUSD'nin saniyede birkaç quote'u bunun çok altında;
  - MetaApi ücreti hesabın deploy süresine göre (eski dashboard'un notu: her deploy en az 6 saat faturalanıyor); web hesabı deploy etmediği için ek ücret beklenmez. İlk gün MetaApi faturalama sayfasına bakmak yine de iyi olur;
  - web hesabı asla deploy/undeploy etmez. Hesap deploy'lu değilse başlıkta "(canlı fiyata bağlanılamadı)" yazar, loglara `[web] canlı fiyat akışı başlatılamadı: ...` düşer; sayfa açıkken 30 sn'de bir yeniden dener.
  - Token eski dashboard'unkinden farklı ve yalnız geçmiş mum API'sine yetkiliyse bağlantı reddedilir; o zaman eski dashboard'un token'ını kullan.

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
├ ƒ /api/piyasa/canli
├ ƒ /api/piyasa/heatmap
├ ƒ /api/piyasa/mumlar
├ ƒ /dogrulama
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

Adresi açınca giriş sayfası gelir. Girişten sonra Piyasa sayfası açılır; loglara `[web] giriş yapıldı (IP)` düşer. Hatalı denemeler `[web] giriş: hatalı (IP, 3/10)` olarak görünür. MetaApi değişkenleri varsa Piyasa ilk açıldığında birkaç saniye ile birkaç dakika içinde `[web] canlı fiyat akışı hazır: BTCUSD` düşer.

- Yalnız `apps/web`'i değiştiren bir merge yalnız web'i yeniden deploy eder; collector ve core çalışmaya devam eder.
- `packages/db`'yi ya da `package-lock.json`'u değiştiren bir merge collector ve core'u da yeniden başlatır. Heatmap turuna denk gelmesin diye böyle merge'leri xx:00–xx:06 dışında yap.

## 6. Giriş ve oturum

- Oturum imzalı bir çerezde (`hakari2_session`); sunucuda oturum tablosu yok. 30 gün geçerli, kullandıkça uzar; girişten 90 gün sonra yeniden giriş istenir.
- Aynı IP'den 15 dakikada 10 hatalı denemede o IP 15 dakika kilitlenir (servis yeniden başlayınca sayaç sıfırlanır).
- Başka bir siteden gönderilen form ve yazan istekler reddedilir.
- Menüdeki "Çıkış yap" (telefonda "Çıkış") çerezi siler.

## 7. Piyasa sayfası

Sayfa dakikada bir kendini yeniler (sekme arka plandaysa yenilemez); fiyat ve oluşan mum canlı akışla anlık. Bütün saatler İstanbul saati; fiyatlar Axi BTCUSD.

- **Üst satır:** canlı fiyat (son quote'un bid'i; Axi mumları da bid'den) ve saati, akış yoksa son 1m mumunun kapanışı; dünkü günlük kapanıştan değişim; baz (en yeni 24h heatmap'te CoinGlass ile Axi fiyat farkı), ATR 4h, günlük bias.
- **Grafik:** tek temel grafik, Axi mumları. Dilim düğmeleri 5m, 15m, 1h, 4h, 1d (açılışta 15m).
  - Sürükleyerek geçmişe kaydırılır, tekerlekle yakınlaştırılır, fiyat ekseni sürüklenerek dikeyde ölçeklenir. Sola kaydırdıkça daha eski mumlar okunur.
  - Son mum oluşan mum: kayıtlı son mumdan sonrası kapanmış 1m mumlarından, canlı akış varken her quote'la güncellenir; dilim dolunca yeni mum açılır. Collector dilimin mumunu yazınca yerine o geçer. Her yeni 1m mumunda oluşan mumun açılış, tepe ve dibi 1m mumlarıyla düzeltilir (quote'larla görülen uçlar korunur).
  - Beyaz etiketli çizgi canlı fiyat (akış yoksa son 1m kapanışı).
  - İmleç mumun açılış, tepe, dip ve kapanışını, imlecin fiyatını, altındaki heatmap hücresinin likidasyonunu ve imleç bir bölgenin içindeyse o bölgeyi gösterir.
- **Katman düğmeleri** (aynı zamanda lejant; seçimler, dilim ve heatmap penceresi tarayıcıda hatırlanır):
  - **Heatmap:** CoinGlass model1 likidasyon seviyeleri mumların arkasında; koyuluk o fiyattaki likidasyon miktarı, kesik dikey çizgi heatmap'in alındığı an. Son sütun (o anki seviyeler) grafiğin sağ kenarına kadar uzar. Sağ kenardaki gri çubuklar fiyat seviyesine göre toplam likidasyon (profil); heatmap'in kapsamadığı uzun aralıklarda da görünür. Heatmap ve cluster'lar baz kadar kaydırılır, yani Axi fiyatıyla çizilir; snapshot anına ait Axi mumu yoksa CoinGlass fiyatıyla çizilir ve altta yazar.
  - **Cluster'lar:** core'un `heatmap_levels` tablosundan, fiyatın üstünde ve altında en çok üçer çizgi. Numara core'daki sıra: 1 eski sistemin kullandığı en büyük cluster (düz çizgi), 2 ve 3 aynı kuralın kalan seviyelerde tekrarı (kesik). Grafiğin sağ ucu görünürken fiyat ekseni fiyatın %6'sından yakın en yakın cluster'ları da kapsar.
  - **Destek/direnç:** yalnız core'un gösterdiği bölgeler: fiyatın ±%5'inde, üstte ve altta en güçlü 3 ve fiyatın içinde olduğu bölge. Her biri belirdiği andan sağ kenara sabit bir mor bant; sağda gücü yazar (heatmap açıksa profilin solunda). Seçim her 4h kapanışında yenilenir; gösterilen bir bölgenin yerine ancak iki kat güçlü bir bölge geçer.
  - **Önceki gün/hafta:** dünün tepe ve dibi (pdh, pdl), geçen haftanın tepe, dip, açılış ve kapanışı (pwh, pwl, pwo, pwc); kesik çizgiler. Gün 00:00'da, hafta pazartesi 00:00'da (İstanbul) başlar.
- **Heatmap penceresi** (heatmap ya da cluster katmanı açıkken): 12h, 24h, 48h (açılışta 24h) ve son güncelleme anı. Hep pencerenin en yeni snapshot'ı gösterilir; dakikalık yenileme yenisini getirir. Geçmiş snapshot'lar veritabanında; simülasyonda kullanılacak (API'de `&id=` ile okunabilir).
- **Grafiğin altında** yalnız açık katmanların ayrıntısı: gösterilen bölgeler yukarıdan aşağı, aralarında fiyat (bant, uzaklık, güç, kaynak: gücün çoğunun geldiği dilim, test, tuttu, kırıldı, belirdiği gün); cluster'lar ve bant likiditesi (referansın %1, %2 ve %3 altı ve üstü); önceki gün ve hafta seviyeleri.
- **Yan sütun:** ZLEMA, RSI ve ATR (15m, 1h, 4h ve 1d'nin kapanmış son mumu, `axi_indicators`); Long/Short; günlük bias (son rapor: yön, güven, net yön, skor, sonuç metni).
- **Long/Short:** Binance global ve top trader oranı ve dört dilimin açısı (son noktanın; pencerede eksik nokta varsa boş), eski sistemin live ekranındaki gibi seçili dilimin son 30 noktasının grafiği: oran, ortalaması (noktalı) ve açının hesaplandığı doğru (kesik; yükselen yeşil, düşen turuncu). Dilim düğmeleri 5m, 15m, 1h, 4h (açılışta 5m, seçim hatırlanır). 15m, 1h ve 4h serileri core'daki gibi dilim sınırındaki (UTC) 5m noktaları.
- Grafik kütüphanesi TradingView Lightweight Charts (Apache 2.0); lisans gereği fiyat grafiğinin köşesinde TradingView logosu ve sayfada atıf var.

Grafik verisini API verir; uçlar giriş ister ve önbelleğe alınmaz:

| Uç | Ne verir |
|---|---|
| `/api/piyasa/mumlar?tf=1h[&before=<ms>\|&after=<ms>][&n=600]` | Axi mumları, eskiden yeniye: en yeni n, ya da bir andan önceki n (geçmişe kaydırınca), ya da bir andan sonrakiler (yeni kapanışlar). n en çok 2000. `forming`: henüz kaydedilmemiş oluşan mumlar (önceki ve şimdiki aralık, 1m mumlarından; before'da yok) |
| `/api/piyasa/bolgeler` | core'un son sürümünün geçerli bölgeleri ve hangilerinin gösterileceği |
| `/api/piyasa/heatmap?span=24h[&id=<snapshot>]` | pencerenin en yeni (ya da id'si verilen) snapshot'ının ısı ızgarası, cluster'ları, bant likiditesi ve bazı |
| `/api/piyasa/canli` | canlı fiyat akışı (Server-Sent Events): `hello` (akışın durumu, son quote), `quote` (bid, ask, an; istemci başına en çok 250 ms'de bir), hazır değilken 5 sn'de bir `status`; 15 sn'de bir boş satır |

Sayfanın dakikalık yenilemesi büyük veriyi yeniden göndermez, yalnız "değişti mi" işaretlerini taşır: yeni 1m mumu gelince grafik seçili dilimin son mumlarını, core bölgeleri yeniden hesaplayınca bölgeleri, seçili pencerede yeni snapshot olunca heatmap'i okur. L/S grafiklerinin noktaları sayfayla gelir (8 seri × 30 nokta).

Canlı akış tarayıcıda sekme başına tek bağlantı; sekme 30 sn arka planda kalınca kapanır, dönünce yeniden açılır. Sunucuda bütün tarayıcılar MetaApi'ye açılan tek bağlantıyı paylaşır. 30 sn quote gelmezse (piyasa arası) başlıkta "son quote" ve saati yazar, grafik son 1m kapanışına döner.

## 8. Doğrulama sayfası

Eski sistemin naif kuralı yeni sistemin verisiyle ne kadar aynı çalışıyor: kararları ve benzetilen işlemleri core hesaplar (`naive_decisions`; kural ve sütunlar core dokümanının 5. bölümünde), sayfa bunları eski sistemin gerçek naif işlemleriyle (magic 7575, `legacy_orders`) karşılaştırır. Dakikada bir kendini yeniler; saatler İstanbul saati.

- **Başlık:** tek cümle: kaç gerçek naif işlemin karşılığında yeni sistemin de aynı sinyali verdiği, kapananlarda sonucun aynı olup olmadığı.
- **Özet:** iki dönem yan yana. *Yeniden oynatma*: eski sistemden kopyalanan 12h snapshot'ları, yani eski döngülerin kendisi. *İleri izleme*: collector'ın saatlik 12h snapshot'ları. Satırlar: karar, sinyal, gerçek naif işlem, karşılığında sinyal olan, TP ve SL aynı (±1 kuruş), sonuç aynı, R (gerçek ve benzetim, ikisi de kapanmış aynı işlemlerde), sinyal çıkmayan gerçek işlemler ve nedenleri, gerçek karşılığı olmayan sinyaller ve benzetim R'leri.
- **Benzetimin gerçeğe yakınlığı:** eşleşen sinyallerde giriş farkı (gerçek dolum − benzetim girişi, aleyhe pozitif), gecikme (gerçek açılış − karar anı), TP dolumu, SL kayması ve çıkış anı farkı; %10, medyan ve %90. Sanal broker bu ölçülerle ayarlanacak.
- **Gerçek naif işlemler ve karşılıkları:** en yeni üstte. Açılış, yön, dolum, TP/SL (benzetiminki farklıysa altında), gerçek sonuç (R ve süre), benzetimin sonucu ya da sinyal çıkmama nedeni, giriş farkı, eşleşme şekli.
- **Gerçek işlemi olmayan sinyaller** ve **kural** (setup, bölge, pencere, işlem benzetimi).

Eşleşme: gerçek emir önce aynı Apify çalıştırmasının kararıyla eşleşir (`apify_run_id`). Çalıştırma tutmazsa (ileri izlemede snapshot'lar ayrı, eski sistemin bazı snapshot'ları da kopyalanmamış) emrin ±20 dakikasındaki karar alınır, aynı yönde sinyal olan önce. Her karar tek gerçek işleme eşleşir. Gerçek R: LONG (kapanış − dolum) / (dolum − SL), SHORT tersi.

Core kararları henüz yazmadıysa sayfa "Henüz karar yok" der.

## 9. Sağlık sayfası nasıl karar veriyor

Sayfa `collector_status` ve `collector_runs` tablolarını okur, 30 saniyede bir kendini yeniler (sekme arka plandaysa yenilemez). Bütün saatler İstanbul saati.

Her kaynak için "sıradaki veri ne zaman gelmeliydi" hesaplanır. Beklenen andan sonra bir pay kadar gelmezse **gecikmeli** (sarı), iki pay geçerse **durdu** (kırmızı):

| Kaynak | Sıradaki veri | Pay |
|---|---|---|
| Axi mumları (1m–1d) ve göstergeler (15m–1d) | son mumun kapanışından bir dilim sonra | dilimin %10'u, en az 3 dk (1d'de 2,4 sa) |
| Heatmap 12h, 24h, 48h ve seviyeler | son snapshot'tan 1 saat sonra (bütçe kısınca 2 saat) | 15 dk |
| L/S global, top trader ve açılar | son noktadan 5 dk sonra | 7 dk |
| Bakım işleri: boşluk denetimi, sembol bilgisi, Apify bütçesi, eski sistem kopyası | son başarılı çalışmadan işin aralığı kadar sonra | aralığın %10'u, en az 2 dk; en çok sarı |
| Geçmiş doldurma | izlenmez, yalnız hata | en çok sarı |
| Naif kural kararları | son döngüden 1 saat sonra; kaynağı heatmap seviyeleri | 15 dk |
| Günlük bias | hafta içi 09:07 | hafta içi 12:00'ye kadar bugünkü rapor yoksa kırmızı; öncesinde "bekleniyor", hafta sonu rapor beklenmez; okuma hatası rapor gecikmedikçe sarı |

- Kaynak hata veriyorsa (`consecutive_failures > 0`) satırda son hata ve kaç kez üst üste olduğu yazar. Veri hâlâ zamanındaysa ve hata 3 kez üst üste değilse sarı (geçici: zaman aşımı, tekrar deneniyor), değilse kırmızı.
- Göstergeler kaynağı yüzünden gecikiyorsa (Axi 15m mumu gelmiyorsa 15m göstergesi de gecikir) satırda "Kaynakta sorun var" yazar; özette yalnız kaynak sayılır.
- Son 24 saatte 3 ya da daha çok hata veren kaynakta, düzelmiş olsa da satırda hata sayısı görünür.
- "Son hatalar" tablosu son 7 günün en yeni 12 hatası (`collector_runs`'taki başarısız kayıtlar). Heatmap'te her başarısız deneme ayrı satırdır.
- Çubuk son veriden bu yana geçen süreyi gösterir: çentikte sıradaki veri beklenir, sarı bölgeye geçerse gecikmeli, sona dayanırsa durdu.

## 10. Yerelde çalıştırma

```
DATABASE_URL="<Postgres'in DATABASE_PUBLIC_URL'i>" PGSSL=true WEB_USER=ari WEB_PASSWORD=deneme \
  npm run dev -w @pt/web
```

Sonra http://localhost:3000. Yerelde çerez Secure olmadan yazılır (http); Railway'de https olduğu için Secure.
