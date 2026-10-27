# Simülasyon yorumu rutini

"Hakari Simülasyon Yorumu" zamanlanmış görevinin talimatları (Claude, Ari için yazdı; görev her gün 09:37 İstanbul).
Amaç: core'un kombinasyon simülasyonu koşularını (`runs/<id>.json`) okuyup Türkçe analiz ve yorum yazmak
(`yorum/<id>.json`). Core yorumu alıp Hakari 2'nin Simülasyon sayfasında gösterir. Bu dalda yalnız `yorum/` altına
dosya eklenir; `main`'e ve başka hiçbir dosyaya dokunulmaz.

## 1. Yorumsuz koşuları bul

Bu klasörde (sim-data dalının çalışma kopyası): `runs/` altındaki her `<id>.json` için `yorum/<id>.json` var mı?
Yoksa o koşu yorumsuzdur. Hiç yorumsuz koşu yoksa başka bir şey yapma; son mesajın tek satır olsun:
"Yorumsuz koşu yok."

En yeniden başlayarak (büyük numara önce) en çok 3 yorumsuz koşu için 2–4. adımları uygula.

## 2. Oku

`runs/<id>.json`'u baştan sona oku. `run.previous_id` doluysa `runs/<previous_id>.json`'u ve varsa onun yorumunu
(`yorum/<previous_id>.json`) da oku: önceki yorumun öne çıkardığı bulgu arada geçen dönemde ne oldu, onu söyleyeceksin.
Önceki koşunun dosyası yoksa yalnız bu koşudaki `results.validation`'a dayan.

Dosyanın alanları:
- `run`: `id`, `kind` (aylik: her ayın 1'i 04:00; elle: sayfadaki düğmeyle), `data_from`, `data_to` (verinin aralığı),
  `previous_id` (denetlenen önceki koşu).
- `results.data`: `candidates` (long ve short aday sayısı), `months` (ay ay gün, heatmap'li saat, karar noktası,
  filtresiz işlem sayısı ve toplam R).
- `results.sides.LONG` / `results.sides.SHORT`: `base` (filtresiz: `n` işlem, `sumR` toplam R, `avgR` işlem başına R,
  `win` kazanma oranı, `maxDD` en büyük düşüş, R), `tested` (denenen kombinasyon), `enough` (30+ işlemli olan),
  `top` (en iyi 10: `label`, `conds`, `n`, `sumR`, `avgR`, `win`, `maxDD`), `null` (şans testi: `runs` tekrar,
  `p50` ortanca, `p95` %95'lik değer, `rank` gerçek en iyinin tekrarlardan iyi olduğu pay).
- `results.combined`: en iyi long ve en iyi short ayrı yuvalarda (`n`, `sumR`, `maxDD`, `overlapHours` iki yönün
  birlikte açık kaldığı saat, `nullSumP50`, `nullSumP95`). `results.base2`: filtresiz, iki yön ayrı yuvalarda.
- `results.validation` (önceki koşu varsa): `previousRunId`, `from`–`to` aralığı (önceki koşunun verisinin bittiği andan
  bu koşunun sonuna), `rules` (önceki koşunun her yöndeki en iyi 10 kombinasyonundan toplam R'si artıda olanlar: `side`,
  `rank`, `label`, `previous` o koşudaki sonucu, `forward` bu aralıktaki sonucu, `baseForward` aynı aralığın filtresiz
  tabanı, `verdict`) ve `combined` (önceki long #1 ve short #1 birlikte; ikisi de artıdaysa).
- `verdict`: `tutuyor` = aralıkta en az 10 işlem, toplam R artıda ve işlem başına R aynı aralığın filtresiz tabanından
  aşağı değil; `tutmuyor` = bunlardan biri sağlanmadı (kural kazandırmış olsa bile filtresiz tabandan kötüyse filtre
  değer katmamıştır); `veri_az` = 10'dan az işlem; `gecersiz` = kuralın bir koşulu bu koşuda yok.
- `results.rules`: bu koşunun bir sonraki koşuda denetlenecek kuralları (aynı seçim).
- R: işlem başına risk birimi (SL mesafesi 1 R). Zamanlar ms ya da ISO (UTC); yazarken İstanbul saatiyle tarih kullan.
  Ondalıklar dosyada 4 haneye yuvarlıdır; `curve` alanları ([kapanış anı, birikimli R] çiftleri) ve `null.values`
  (200 şans tekrarının en iyileri) uzun listelerdir, özet alanlar yeterliyse onları tek tek incelemen gerekmez.
- `results.params`: motorun ayarları (12h heatmap, ZLEMA oluşan mumla, TP/SL %75, en az 30 işlem, 200 şans tekrarı).

## 3. Analiz et

Yalnız bu dosyalardaki sayılarla konuş; sayı uydurma, fiyat teknik analizi yapma.

- Ana soru: bu koşuda şanstan ayrışan bir kombinasyon var mı? Her yön için en iyi kombinasyonun toplam R'si
  (`top[0].sumR`) şans testinin %95'lik değerinin (`null.p95`) üstündeyse "şanstan ayrışıyor", değilse "şansla
  açıklanabilir". 30 işlem eşiğine yakın sonuçlara ve max DD'ye dikkat et.
- Önceki bulgu (validation varsa): hangi kurallar tuttu, hangileri tutmadı, hangilerinde veri az; birleşik kural.
  Tutmayan ama artıda kalan kuralları ayrıca söyle (kazandırdı ama filtresiz tabanı geçemedi). Önceki koşunun en iyi
  kuralı bu koşunun en iyileri arasında yine var mı (`label` karşılaştır)? Tutanların sayısı şansla beklenenden fazla
  mı (yaklaşık yarısının tesadüfen tutması olağan)? Önceki koşunun şans testi sonucu (onun `sides.*.null.p95`'i) neydi:
  şansla açıklanabilir bir bulgunun tutmaması beklenen sonuçtur.
- Yön: filtresiz long ve short arasındaki fark (`sides.*.base`, aralık için `validation.rules[].baseForward`); ay ay
  dağılımdan dönemin hangi yöne uygun olduğu (kesin konuşma). Kurallardan çok yönün belirleyici olduğu durumu açıkça
  söyle.
- İstikrar: önceki koşuyla karşılaştırınca tekrar eden koşullar (ör. yakın/uzak oranı, belirli bir ZLEMA durumu).
- Veri yeterliliği: işlem sayıları ve ay ay kapsam; karar için ne kadar veri gerektiği.
- Öneri: yalnız veri destekliyorsa ve somutsa (ör. "short #1 kuralını bir ay daha izle", "şu koşulu ayrı test et");
  en çok 3 madde. Kesin al-sat ya da para yönetimi tavsiyesi verme.
- Güven: Düşük (şanstan ayrışan yok ya da veri az), Orta (bir yönde ayrışıyor ama önceki denetim zayıf), Yüksek
  (şanstan ayrışıyor ve önceki dönemde de tutmuş).

## 4. Yaz ve doğrula

`yorum/<id>.json` (geçerli JSON; yorum satırı yok):

```json
{
  "run_id": 12,
  "generated_at": "2026-11-01T06:40:00Z",
  "ozet": "2–4 cümle: bu koşunun ana sonucu, şans testine göre.",
  "gecerlilik": "Önceki koşu varsa 2–4 cümle: kuralları arada geçen dönemde tuttu mu. Yoksa boş metin.",
  "bulgular": ["1–5 madde; her biri tek cümle, sayılarla."],
  "oneriler": ["0–3 madde."],
  "guven": "Düşük | Orta | Yüksek",
  "model": "<model kimliğin>",
  "prompt_version": "v1"
}
```

`run_id` dosya adındaki numarayla aynı sayı. `generated_at` dosyayı yazdığın an: tahmin etme, `date -u +%Y-%m-%dT%H:%M:%SZ` çıktısını kullan (sayfada "Claude, <saat>" olarak görünür). Türkçe, kısa cümleler; sayılar Türkçe biçimde (+4,5 R, %83, 21 Eylül).

Doğrula: `node tools/yorum-dogrula.mjs yorum/<id>.json`. Hata verirse düzelt ve tekrar doğrula; geçmeden commit'leme.

## 5. Commit ve push

Yalnız yeni yorum dosyalarını:

```sh
git -C <sim-data klasörü> add yorum/<id>.json
git -C <sim-data klasörü> -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "sim: koşu #<id> yorumu"
git -C <sim-data klasörü> push origin sim-data
```

Push reddedilirse bir kez `git -C <sim-data klasörü> pull --rebase origin sim-data` ve tekrar push. 403 gibi yetki
hatasında tekrar deneme. `main`'e ve başka hiçbir dosyaya dokunma; `claude/` önekli dal açma.

Son mesajında her yorum için tek satır özet ve "push edildi (commit <kısa sha>)" yaz; başarısızsa nedenini ve git'in
tam hata mesajını yaz.
