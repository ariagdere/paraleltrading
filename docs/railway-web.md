# web servisi (Railway)

web, Hakari 2'nin tarayıcıdan açılan yüzü. Şimdilik tek sayfa var: **Sağlık**. Her veri kaynağının son verisinin ne zaman geldiğini, sıradakinin ne zaman beklendiğini, gecikenleri ve hataları gösterir. Sonraki sayfalar (heatmap grafiği, piyasa değerleri) aynı servise eklenecek.

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
├ ƒ /login
└ ƒ /saglik
ƒ Proxy (Middleware)
```

Deploy loglarında:

```
▲ Next.js 16.4.2
✓ Ready in ...
```

Adresi açınca giriş sayfası gelir. Girişten sonra Sağlık sayfası açılır; loglara `[web] giriş yapıldı (IP)` düşer. Hatalı denemeler `[web] giriş: hatalı (IP, 3/10)` olarak görünür.

- Bu PR `package-lock.json`'u ve `packages/db/package.json`'u değiştirdiği için merge edilince collector ve core da yeniden başlar. Heatmap turuna denk gelmesin diye merge'ü xx:00–xx:06 dışında yap.

## 6. Giriş ve oturum

- Oturum imzalı bir çerezde (`hakari2_session`); sunucuda oturum tablosu yok. 30 gün geçerli, kullandıkça uzar; girişten 90 gün sonra yeniden giriş istenir.
- Aynı IP'den 15 dakikada 10 hatalı denemede o IP 15 dakika kilitlenir (servis yeniden başlayınca sayaç sıfırlanır).
- Başka bir siteden gönderilen form ve yazan istekler reddedilir.
- Menüdeki "Çıkış yap" çerezi siler.

## 7. Sağlık sayfası nasıl karar veriyor

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

## 8. Yerelde çalıştırma

```
DATABASE_URL="<Postgres'in DATABASE_PUBLIC_URL'i>" PGSSL=true WEB_USER=ari WEB_PASSWORD=deneme \
  npm run dev -w @pt/web
```

Sonra http://localhost:3000. Yerelde çerez Secure olmadan yazılır (http); Railway'de https olduğu için Secure.
