-- 012: elle zonları grafikten ekleme, düzenleme ve pasife alma (Ari, 18 Kasım 2026)
--
-- Piyasa grafiğinden ve eski sistemin /live grafiğinden (paralel web'in API'si üzerinden) zon eklenir, düzenlenir,
-- pasife alınır. Zon silinmez: düzenleme yeni numaralı zon açar, eskisi ended_at ile kapanır; yeni zon mevcut birini
-- kesiyor ya da ona çok yakınsa kullanıcı onaylarsa o da kapanır. Yeni zon kaydedildiği andan geçerli (created_at);
-- geçmişin tekrarı değişmez.
--
-- breaks_from: kırılma (dönüşüm) takibinin başlangıcı; NULL ise created_at (010'daki zonlar). Düzenlemede eski zonun
-- başlangıcından devam eder, yeni zonda seçilir (varsayılan 1 Eylül 2026 00:00 İstanbul, ilk 15 zon gibi). Kırılmalar
-- bu andan zonun kendi (yeni) sınırlarıyla sayılır; 4h kapanışı değilse ondan sonraki ilk kapanıştan.
-- replaces: yerine geçtiği zonlar (düzenlenen ve onayla kapatılan). replaced_by / end_reason: kapanan zonda yerine
-- geçen zon ve neden (duzenleme, cakisma, kapatma). source: nereden yazıldığı (piyasa, live; NULL: elle SQL).
ALTER TABLE elle_zones
  ADD COLUMN IF NOT EXISTS breaks_from timestamptz,
  ADD COLUMN IF NOT EXISTS replaces    integer[],
  ADD COLUMN IF NOT EXISTS replaced_by integer,
  ADD COLUMN IF NOT EXISTS end_reason  text,
  ADD COLUMN IF NOT EXISTS source      text;

ALTER TABLE elle_zones DROP CONSTRAINT IF EXISTS elle_zones_breaks_from_check;
ALTER TABLE elle_zones ADD CONSTRAINT elle_zones_breaks_from_check CHECK (breaks_from IS NULL OR breaks_from <= created_at);
ALTER TABLE elle_zones DROP CONSTRAINT IF EXISTS elle_zones_end_reason_check;
ALTER TABLE elle_zones ADD CONSTRAINT elle_zones_end_reason_check
  CHECK (end_reason IS NULL OR end_reason IN ('duzenleme', 'cakisma', 'kapatma'));
ALTER TABLE elle_zones DROP CONSTRAINT IF EXISTS elle_zones_source_check;
ALTER TABLE elle_zones ADD CONSTRAINT elle_zones_source_check CHECK (source IS NULL OR source IN ('piyasa', 'live'));
