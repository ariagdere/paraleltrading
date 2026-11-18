# SDL v3, elle zonlar: canlı işlem

core, elle çizilen zonlarla SDL v3 kurulumlarını her 3m kapanışında arar, kararını yazar ve kurallardan geçen kurulumda Axi'ye emir gönderir. Emir eski sistemin hesabına magic **15033** ile gider. Eski sistemin `mt5_order_monitor`'ü emri MT5 akışından görür ve eski DB'nin `orders` tablosuna **"SDL_v3 - Manuel Zone No Cap"** etiketiyle yazar; emir /live'da görünür. Yeni sistem eski DB'ye yazmaz.

Kod: `apps/core/src/sdl/`. Şema: `packages/db/migrations/010_sdl.sql`. Sayfa: web'de **SDL**. Kararlar: Ari, 18 Kasım 2026 (proje notu `claude/sdl-elle-canli-plani.md`).

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
  - Kırılmalar zonun `created_at` anından sayılır.
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

## Kayıtlar

| Tablo | İçerik |
|---|---|
| `elle_zones` | Zonlar. id kalıcı numara; yeni zon yeni numara, kapatırken `ended_at`. 15 zon migration'da (1 Eylül 00:00'dan). |
| `sdl_bars` | Akıştan kurulan 1m mumlar. |
| `sdl_setups` | Kurulumlar ve kararları: `mode` canli ya da tekrar; `decision` emir ya da atla; `reason` atlama sebebi. Benzetilen sonuç (`sim_*`) saatte bir. |
| `sdl_orders` | Emir niyetleri ve MetaApi sonucu (MT5 emir ve pozisyon numarası, dolum). |
| `trading_switch` | NO TRADE düğmesi (`sdl_elle`). |
| `sdl_status` | core'un SDL durumu: Railway anahtarı, ayarlar, fiyat akışı. |

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
