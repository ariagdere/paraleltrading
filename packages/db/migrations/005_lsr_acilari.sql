-- 005: core'un L/S serisinden hesapladığı açılar
--
-- Her metrik (global, top_position) ve dilim (5m, 15m, 1h, 4h) için serinin her noktasında biten 30 noktalık
-- pencerenin açısı. 15m, 1h ve 4h serileri 5m serisinden alınır: dilim sınırındaki (UTC) 5m noktaları. Eski veride
-- Binance'in 1h noktası aynı zamandaki 5m noktasıyla birebir aynı; 4h sınırları da Binance'inki gibi UTC 00/04/08...
--
-- Formül eski sistemin (hakari-lsr-refresher/lsrAngle.js): pencerenin ortalamaya göre normalize değerlerine x = 0…1
-- doğrusu oturtulur; slope pencere boyunca toplam normalize değişim, r2 uyumun güvenilirliği. ref, o noktaya kadarki
-- bütün geçerli pencerelerin |slope| değerlerinin %90'lık değeri (n_ref pencere; 100'den azsa açı yok);
-- angle = atan(slope / ref), derece. Pencerede eksik nokta varsa slope ve angle boş.
--
-- Eski sistem t anındaki açıyı ts ≤ t − dilim olan son noktadan alıyordu (lag 1): o noktanın angle'ı. Nokta
-- t − dilim'den iki dilim ya da daha eskiyse açı yok sayılıyordu.
CREATE TABLE IF NOT EXISTS lsr_angles (
  metric       text             NOT NULL CHECK (metric IN ('global', 'top_position')),
  period       text             NOT NULL CHECK (period IN ('5m', '15m', '1h', '4h')),
  ts           timestamptz      NOT NULL,
  slope        double precision,
  r2           double precision,
  ref          double precision,
  n_ref        integer          NOT NULL,
  angle        double precision,
  computed_at  timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (metric, period, ts)
);
