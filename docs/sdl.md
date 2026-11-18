# SDL v3, elle zonlar: canlı işlem

core, elle çizilen zonlarla SDL v3 kurulumlarını her 3m kapanışında arar, kararını yazar ve kurallardan geçen kurulumda Axi'ye emir gönderir. Emir eski sistemin hesabına magic **15033** ile gider. Eski sistemin `mt5_order_monitor`'ü emri MT5 akışından görür ve eski DB'nin `orders` tablosuna **"SDL_v3 - Manuel Zone No Cap"** etiketiyle yazar; emir /live'da görünür. Yeni sistem eski DB'ye yazmaz.

Kod: `apps/core/src/sdl/`. Şema: `packages/db/migrations/010_sdl.sql`, `011_sdl_bekleyen.sql`. Sayfa: web'de **SDL**. Kararlar: Ari, 18 Kasım 2026 (proje notu `claude/sdl-elle-canli-plani.md`).

## Kurallar

Kurallar araştırma motorunun birebir karşılığı (proje notu `claude/sdl-v3-ornek-trade.md`). Araştırmanın 2 Ekim – 13 Kasım verisiyle aynı sonucu veriyor: 43 kurulum, dönüşüm şartından geçen 21 işlem, elenen 22, +15,85R.

- **Pencere:** hafta içi, 3m kapanışı İstanbul 07:00–20:00.
- **Bias:** o günün son raporu. NEUTRAL ya da rapor yoksa işlem aranmaz.
- **Kurulum:**
  - 3m iFVG, boşluk en az 50 $, aynı gün ve dönüşten en çok 4 saat önce oluşmuş.
  - Giriş: FVG'nin ötesindeki ilk 3m kapanışı. Short'ta bid, long'da ask.
  - İğne zonu aşabilir. SL iğne ± 15 $. TP girişin ötesindeki ilk zonun yakın kenarından 15 $ önce.
- **Dönüşüm şartı:** giriş zonunun girişten önceki son kırılması işlem yönünde olmalı. Hiç kırılmamış zon geçmez.
  - Kırılma: zon oluştuktan sonra bir 4h kapanışının bandın 0,15 ATR(14, Wilder) ötesine geçmesi.
  - Kırılmalar zonun kırılma takibi başlangıcından sayılır (`breaks_from`, yoksa `created_at`; 4h kapanışı değilse ondan sonraki ilk kapanıştan), zonun kendi sınırlarıyla.
- **Haber:** haberden 1 saat önce yeni işlem açılmaz, 30 dk sonra yeniden açılır.
  - Kaynak `calendar_events`: eski DB'nin kırmızı klasörü, saatte bir kopyalanıyor.
  - Bu kural araştırmada yoktu.
- **Yok:** işlem sınırı, 3 kayıp kuralı, BE, süreye bağlı çıkış.
- **Lot:**
  - Hedef risk 10 $; lot adımına aşağı yuvarlanır.
  - Aşağı yuvarlanan lot en küçük lotun altındaysa en küçük lotla girilir, yeter ki o lotta risk 20 $'ı aşmasın. Aşıyorsa işlem yok.
  - Risk = |giriş − SL| × lot × contractSize.

## Mumlar ve karar anı

- **Fiyat akışı:** core MetaApi'ye bir streaming bağlantısı açar ve yalnız BTCUSD quote'larını alır. Web'deki canlı fiyatın aynısı; REST kredisi tüketmez.
  - Quote'lardan 1m mum kurulur (`sdl_bars`): bid fiyatı, dakikadaki en büyük spread.
  - Mum, sonraki dakikanın ilk quote'uyla ya da sınırdan 1,5 sn sonra kapanır.
  - Bağlantıdan sonraki ilk mum ve 20 sn'den uzun sessizlik içeren mum eksik sayılır ve kullanılmaz.
- **Karar:** her 3m kapanışından ~1–2 sn sonra verilir.
  - Son iki dakikanın mumları akıştan gelir; resmi mumun ilk hali o an ya yok ya eksik.
  - Öncekiler collector'ın resmi mumlarından (`axi_candles`) gelir.
  - Akış yoksa ya da 30 sn'dir quote gelmiyorsa hepsi resmi mumlardan; o zaman karar collector'ın turunu bekler (~5–15 sn).
- **Veri gelmezse:** kapanışın son 1m mumu 60 sn içinde hiçbir kaynaktan gelmezse o kapanış atlanır (Sağlık'ta hata).
- **4h mumu:** son kapanan 4h mumu, kapanışından 5 dk geçmediyse 1m'lerden kurulur. Resmi mum kapanıştan sonra bir kez daha çekiliyor; ilk hali eksik olabilir.

## Sırada bekleyen kurulumlar

Her 3m kapanışından sonra, kararın ardından (emir gecikmesine eklenmez) sonraki kapanışlarda giriş verebilecek iFVG'ler `sdl_pending`'e yazılır (`engine.ts` `pendingAt`). SDL sayfasında en üstte, fiyata en yakın tetik başta.

- **Liste:** bias yönünde, boşluğu en az 50 $, henüz dönmemiş, 80 mum içinde ve en geç 20:00'de dönebilecek FVG'ler; giriş zonu dönüşüm şartından geçenler. Dönüşümle elenecek kurulum listelenmez.
- **Tetik:** 3m kapanışının geçmesi gereken seviye.
  - `tetik`: iğnenin ulaştığı zon FVG'nin kenarını kapsıyor; tetik FVG'nin kenarı.
  - `derin`: kapsamıyor; FVG'nin ötesindeki ilk kapanışın zonun kenarını da geçmesi gerekiyor, arada kapanırsa kurulum düşer (30 Ekim 10:45 gibi).
  - `zon`: iğne henüz hiçbir zona ulaşmadı.
- **Değerler** girişin tetikte olacağı varsayımıyla yaklaşık: SL şimdiye kadarki iğneden, TP o girişin ötesindeki ilk zondan, lot ve risk lot kuralıyla.
- **Zaman:** bias geldikten sonra 07:00'den önce de yazılır (o saatten önceki dönüş işlem açmaz ve FVG'yi düşürür). Hafta sonu, 20:00'den sonra ve bias yokken liste boş; sebebi ve haber engeli `sdl_status.pending_info`'da.
- **Doğrulama:** 2 Ekim – 13 Kasım'da kurallardan geçen 21 kurulumun 21'i bir önceki kapanışta listedeydi; dönüşümle elenen 22'den hiçbiri listede değildi.

## Grafik

SDL sayfasında bir satıra (bekleyen, canlı ya da tekrar) tıklayınca altında kurulumun iki grafiği açılır; araştırma sayfasındaki gibi (`claude/sdl-v3-ornek-trade.md`, TradingView pozisyon aracı görünümü):
- **3 dakikalık:** FVG'den ve iğneden 30 dk önce → çıkıştan 15 dk sonra. FVG kutusu, iğne, giriş, zonlar; 1 iğne, 2 FVG, 3 giriş rozetleri.
- **15 dakikalık:** 4 saat önce → çıkıştan 2 saat sonra.
- **Çıkış:** gerçek işlem (eski sistemin kaydı) > benzetim > açık (son fiyat). Bekleyende planlanan pozisyon son mumun sağında, soluk; kesik çizgi tetik.
- Veri `/api/sdl/grafik?kurulum=<id>` ya da `?bekleyen=<SHORT|LONG>-<FVG ms>`; mumlar `axi_candles` 1m'den, resmide olmayan son dakikalar `sdl_bars`'tan.

Dönüşüm şartından elenen kurulumlar sayfadaki listelerde gösterilmez; sayfada dönüşüm şartıyla ilgili açıklama da yok (Ari, 18 Kasım: net bir kural). Kural ve elenenler bu dokümanda ve `sdl_setups`'ta (`reason = 'donusum'`).

## Emir

- **İki anahtar:** emir için ikisinin de açık olması gerekir.
  - Railway'de `SDL_TRADING_ENABLED=true`. Kapalıysa **gölge mod**: kararlar yazılır, sebep `golge`, emir gitmez.
  - Web'deki **NO TRADE** düğmesi (`trading_switch`). Kapalıyken yeni emir açılmaz; açık pozisyonlar SL/TP'leriyle kalır.
- **Gönderme sırası:**
  - Kurulum ve emir niyeti (`sdl_orders`, SUBMITTING) tek transaction'da yazılır, sonra MetaApi REST'e market emri gider.
  - SL/TP emirle birlikte gönderilir, clientId `PT_<10 karakter>_1`.
  - Aynı kurulum (giriş anı, yön) bir kez yazılır; servis yeniden başlarsa ikinci emir gitmez.
- **Gönderilmeyen durumlar:**
  - 3m kapanışından 60 sn geçtiyse emir gönderilmez (`gec`).
  - Son 15 dakikada sonucu belirsiz emir varsa yeni emir gitmez (`belirsiz_emir`).
- **Belirsiz sonuç:** zaman aşımı, 5xx ya da tanınmayan kod. Emir **tekrar gönderilmez**.
  - Pozisyon clientId'yle aranır: hemen, sonra dakikada bir, 24 saat boyunca.
  - Bulunursa FILLED olur.
- **Hesap:** emirler aynı Axi hesabına gidiyor; hesap hedging modunda (her emir ayrı pozisyon).
- **Lot üst sınırı:** `SDL_MAX_VOLUME`, varsayılan 0,2. SL en az ~65 $ uzakta olduğu için 10 $ riskte lot 0,15'i geçmez.

## Elle zonları ekleme ve düzenleme

Piyasa grafiğinden ve eski sistemin /live grafiğinden (Ari, 18 Kasım). İkisi de paralel web'in `/api/piyasa/elle-zonlar`'ına yazar; /live sunucudan sunucuya, `ZONE_API_TOKEN` ile ([railway-web.md](railway-web.md)).

- **Ekleme:** yeni numara (en büyük numara + 1), kaydedildiği andan geçerli; geçmişin tekrarı değişmez. Kırılma takibi seçilen günden (varsayılan 1 Eylül 2026 00:00, ilk 15 zon gibi): o günden beri zonu geçen 4h kapanışları sayılır, zon hemen giriş zonu olabilir.
- **Düzenleme:** yeni numaralı zon açılır, eskisi aynı anda kapanır (`end_reason` duzenleme, `replaced_by`). Kırılma takibi eskisinin başlangıcından, yeni sınırlarla.
- **Çakışma:** yeni zon geçerli bir zonu kesiyorsa ya da aradaki boşluk 0,15 × ATR(14) 4h'den (kırılma eşiği; okunamazsa 150 $) küçükse kaydetmeden önce onay sorulur. İşaretli bırakılan çakışan zonlar kapanır (`cakisma`), işareti kaldırılanlar kalır. Düzenlemede düzenlenen zon bu denetime girmez.
- **Pasife alma:** zon yalnız kapanır (`kapatma`).
- **Uyarı (ek onay):** zon 20 $'dan dar, 2.000 $'dan geniş ya da fiyattan %25'ten uzak.
- Kayıt tek transaction'da, tablo kilitliyken: kullanıcının gördüğü çakışmalar o an sunucudakiyle aynı değilse (arada başka ekrandan değiştiyse) kaydedilmez, güncel çakışmalar gösterilir.
- core zonları dakikada bir okur: değişiklik kararlara en geç 1 dakikada, bekleyen listesine bir sonraki 3m kapanışında girer. Açık pozisyonların SL/TP'si değişmez.
- Kolonlar: `breaks_from` (kırılma takibi), `replaces` (yerine geçtiği zonlar), `replaced_by`, `end_reason`, `source` (piyasa, live; boş: elle SQL).

## Kayıtlar

| Tablo | İçerik |
|---|---|
| `elle_zones` | Zonlar. id kalıcı numara; silinmez, kapatırken `ended_at`. 15 zon migration 010'da (1 Eylül 00:00'dan). 012'den beri grafikten eklenir ve düzenlenir (aşağıda). |
| `sdl_bars` | Akıştan kurulan 1m mumlar. |
| `sdl_setups` | Kurulumlar ve kararları: `mode` canli ya da tekrar; `decision` emir ya da atla; `reason` atlama sebebi. Benzetilen sonuç (`sim_*`) saatte bir. |
| `sdl_orders` | Emir niyetleri ve MetaApi sonucu (MT5 emir ve pozisyon numarası, dolum). |
| `trading_switch` | NO TRADE düğmesi (`sdl_elle`). |
| `sdl_status` | core'un SDL durumu: Railway anahtarı, ayarlar, fiyat akışı, bekleyen listesinin anı ve durumu. |
| `sdl_pending` | Sırada bekleyen kurulumlar; her 3m kapanışında baştan yazılır. |

**Geçmişin tekrarı** (`mode = tekrar`):
- `SDL_REPLAY_FROM`'dan bu yana bütün kurulumları aynı kurallarla, resmi mumlarla yeniden hesaplar. Bias raporu araştırmadaki gibi üretildiği andan geçerli sayılır.
- Açılışta ve saatte bir (xx:50) çalışır; satırlar baştan yazılır.
- Canlı kurulumların benzetilen sonucunu da (kendi SL/TP'leriyle) doldurur.
- Gölge modda canlı kararlar ertesi gün tekrarla karşılaştırılır.

## Geçiş adımları

1. **Hakari tarafı:** önce `metaapi-webhook` (monitör) ve `hakari-dashboard` (mutabakat) değişiklikleri deploy edilir. Magic 15033 → etiket; comment okunmaz; Make'e bildirim yok.
2. **Gölge mod:** core'a `METAAPI_TOKEN` ve `METAAPI_ACCOUNT_ID` eklenir; `SDL_TRADING_ENABLED` yok ya da `false`.
   - SDL sayfasında fiyat akışı "bağlı" olmalı, "Son karar" her 3 dakikada ilerlemeli.
   - Tekrar tablosu araştırmanın sonucunu vermeli.
   - En az 3 işlem günü kararlar tekrarla karşılaştırılır.
3. **Deneme:** `SDL_TRADING_ENABLED=true` yapılır, düğme açılır, ilk emir izlenir.
   - /live'da "SDL_v3 - Manuel Zone No Cap" etiketiyle görünmeli.
   - SL/TP MT5'te emirle aynı olmalı.
4. **Canlı:** düğme açık kalır.

Geri dönüş: düğme NO TRADE'e alınır. Gerekirse `SDL_TRADING_ENABLED` silinir; açık pozisyonlar SL/TP'leriyle kalır.

## Bilinen farklar (benzetim ↔ canlı)

- **Giriş:** benzetimde 3m kapanışındaki bid, canlıda emrin gittiği andaki fiyat. Lot o fiyatla hesaplanır.
- **Mum:** akıştan kurulan mumun yükseği ve düşüğü resmi mumdan biraz farklı olabilir; fark iğneyi, dolayısıyla SL'i etkiler. `sdl_bars` ile `axi_candles` karşılaştırılabilir.
- **Bias:** canlıda tabloya düştüğü anda kullanılır. collector 5 dakikada bir okuyor; benzetimde üretildiği anda geçerli.
- **Swap:** benzetimde yok.
