-- 011: SDL, sırada bekleyen kurulumlar (Ari, 18 Kasım 2026)
--
-- core her 3m kapanışından sonra, sonraki kapanışlarda giriş verebilecek iFVG'leri yazar (apps/core/src/sdl/engine.ts
-- pendingAt): bias yönünde, en az 50 $, henüz dönmemiş, 80 mum içinde, giriş zonu dönüşüm şartından geçen. Tablo her
-- kapanışta baştan yazılır (tek transaction); web'deki SDL sayfası listeler ve grafiğini çizer. Bias'ın geldiği andan
-- (06:45) pencerenin sonuna (20:00) kadar; hafta sonu, 20:00'den sonra ve bias LONG/SHORT değilken boş.
-- status: tetik (3m kapanışı FVG'nin kenarını geçince giriş), derin (FVG'nin ötesindeki ilk kapanış zonun kenarını da
-- geçmeli; arada kapanırsa kurulum düşer), zon (iğne henüz hiçbir zona ulaşmadı).
-- Fiyatlar girişin tetik seviyesinde olacağı varsayımıyla: entry short'ta tetik (bid), long'da tetik + spread (ask);
-- SL şimdiye kadarki iğneden; volume ve risk_usd o girişte lot kuralıyla (lot_error: işlem yok sebebi).
CREATE TABLE IF NOT EXISTS sdl_pending (
  side         text             NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  fvg_a        timestamptz      NOT NULL, -- FVG'nin 1. mumunun açılışı
  day          date             NOT NULL,
  status       text             NOT NULL CHECK (status IN ('tetik', 'derin', 'zon')),
  fvg_i        timestamptz      NOT NULL, -- FVG'nin 3. mumunun açılışı
  gap          double precision NOT NULL,
  fvg_lo       double precision NOT NULL,
  fvg_hi       double precision NOT NULL,
  trigger      double precision NOT NULL,
  ext          double precision NOT NULL,
  ext_t        timestamptz      NOT NULL,
  zone_id      integer          NOT NULL,
  tp_zone_id   integer          NOT NULL,
  entry        double precision NOT NULL,
  sl           double precision NOT NULL,
  tp           double precision NOT NULL,
  risk         double precision NOT NULL,
  rr           double precision NOT NULL,
  volume       double precision,
  risk_usd     double precision,
  lot_error    text,
  expires_at   timestamptz      NOT NULL, -- en son bu 3m kapanışında dönebilir
  as_of        timestamptz      NOT NULL, -- hesaplandığı 3m kapanışı
  PRIMARY KEY (side, fvg_a)
);

-- Listenin durumu: hangi kapanışa göre ve liste neden boş (hafta sonu, pencere kapalı, bias yok...), son kapanış, bias,
-- sonraki kapanış pencere içinde mi, günün kalan haber engeli. core sdl_status satırını yazdıktan sonra günceller.
ALTER TABLE sdl_status ADD COLUMN IF NOT EXISTS pending_as_of timestamptz;
ALTER TABLE sdl_status ADD COLUMN IF NOT EXISTS pending_info jsonb;
