-- 010: SDL v3, elle zonlarla canlı işlem (Ari, 18 Kasım 2026)
--
-- core, elle çizilen zonlarla SDL v3 kurulumlarını her 3m kapanışında arar (apps/core/src/sdl). Kurallar araştırma
-- motorunun birebir karşılığı (claude/sdl-v3-ornek-trade.md): likiditesiz versiyon, hedef girişin ötesindeki ilk zon,
-- iğne zonu aşabilir, dönüşüm şartı; işlem sınırı ve 3 kayıp kuralı yok; hafta içi 07:00–20:00 (İstanbul); haberden
-- 1 saat önce dur, 30 dk sonra başla. Emir MetaApi'ye magic 15033 ile gider; eski sistemin mt5_order_monitor'ü emri
-- MT5 akışından görüp eski DB'nin orders tablosuna "SDL_v3 - Manuel Zone No Cap" etiketiyle yazar (/live). Bu şema
-- yalnız yeni sistemin kendi kayıtları: zonlar, akıştan kurulan mumlar, kurulumlar ve kararları, emir niyetleri,
-- NO TRADE düğmesi.

-- Elle zonlar. id kalıcı numara: kurulumlar ve kırılmalar bu numarayla izlenir; yeni çizilen zon yeni numara alır,
-- eskisi ended_at ile kapanır (silinmez). created_at hem geçerliliğin hem kırılma takibinin başlangıcı (bir 4h
-- kapanışı olması beklenir; değilse ondan sonraki ilk kapanış).
CREATE TABLE IF NOT EXISTS elle_zones (
  id           integer          PRIMARY KEY,
  lo           double precision NOT NULL,
  hi           double precision NOT NULL,
  created_at   timestamptz      NOT NULL,
  ended_at     timestamptz,
  note         text,
  inserted_at  timestamptz      NOT NULL DEFAULT now(),
  CHECK (hi > lo),
  CHECK (ended_at IS NULL OR ended_at > created_at)
);

-- Ari'nin 17 Kasım'da gönderdiği 15 zon (yukarıdan aşağıya #1–#15), 1 Eylül 2026 00:00 İstanbul'dan geçerli.
INSERT INTO elle_zones (id, lo, hi, created_at, note) VALUES
  (1, 85574.84, 85657.33, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (2, 84202.52, 84533.09, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (3, 82698.47, 82835.79, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (4, 81891.66, 82156.12, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (5, 80210.70, 80807.89, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (6, 79097.16, 79340.88, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (7, 77758.93, 78016.76, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (8, 76498.46, 76727.70, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (9, 75472.74, 75711.52, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (10, 74764.29, 74889.01, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (11, 74224.18, 74444.41, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (12, 72275.92, 72739.21, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (13, 66373.28, 66755.08, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (14, 65100.58, 65609.65, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım'),
  (15, 62427.98, 63021.89, '2026-08-31T21:00:00Z', 'Ari, 17 Kasım')
ON CONFLICT (id) DO NOTHING;

-- MetaApi fiyat akışından (BTCUSD bid/ask quote'ları) kurulan 1m mumlar. Fiyatlar bid; spread dakikadaki en büyük
-- (point). Mum dakika dolunca kapanır (sonraki dakikanın ilk quote'u ya da sınırdan 1,5 sn sonra); kapanmış mum
-- değişmez. Karar bu mumlarla dakika sınırında verilir; collector'ın resmi mumları (axi_candles) sonradan gelir.
CREATE TABLE IF NOT EXISTS sdl_bars (
  open_time      timestamptz      PRIMARY KEY,
  open           double precision NOT NULL,
  high           double precision NOT NULL,
  low            double precision NOT NULL,
  close          double precision NOT NULL,
  spread_points  integer,
  quotes         integer          NOT NULL,
  closed_at      timestamptz      NOT NULL DEFAULT now()
);

-- Kurulumlar ve kararları. mode: canli (o anda verilen karar) ya da tekrar (geçmişin aynı kurallarla yeniden
-- oynatılması: resmi mumlar, bias raporunun üretildiği an; benzetilen sonuçla). Aynı kurulum (mod, giriş anı, yön)
-- bir kez yazılır; canlıda emir yalnız satır ilk kez yazıldığında gönderilir.
-- Zamanlar: entry_t dönüş mumunun (3m) kapanışı = karar anı; entry_candle o mumun açılışı.
-- Fiyatlar: entry_ref short'ta bid (kapanış), long'da ask (kapanış + spread); risk |entry_ref − sl| ($).
-- decision: emir (canlıda emir gönderildi; tekrarda gönderilirdi) ya da atla. reason (atla'nın sebebi):
--   hafta_sonu, donusum (giriş zonunun son kırılması işlem yönünde değil ya da hiç kırılmamış), haber (haberden 1 saat
--   önce – 30 dk sonra), lot (en küçük lotta risk sınırı aşılıyor), golge (Railway'de SDL_TRADING_ENABLED kapalı),
--   no_trade (NO TRADE düğmesi), gec (kapanıştan bu yana 60 sn geçti), belirsiz_emir (son 15 dakikada sonucu belirsiz
--   emir var), emir_hatasi (fiyat ya da sembol bilgisi alınamadı, emir gönderilemedi).
-- bars: kararın mum kaynağı (akis: son dakikalar fiyat akışından; resmi: hepsi axi_candles'tan).
CREATE TABLE IF NOT EXISTS sdl_setups (
  id             bigserial        PRIMARY KEY,
  mode           text             NOT NULL CHECK (mode IN ('canli', 'tekrar')),
  entry_t        timestamptz      NOT NULL,
  side           text             NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  day            date             NOT NULL,
  entry_candle   timestamptz      NOT NULL,
  zone_id        integer          NOT NULL,
  tp_zone_id     integer          NOT NULL,
  entry_in_zone  integer[]        NOT NULL DEFAULT '{}',
  bias_at        timestamptz      NOT NULL,
  fvg_a          timestamptz      NOT NULL,
  fvg_i          timestamptz      NOT NULL,
  gap            double precision NOT NULL,
  fvg_lo         double precision NOT NULL,
  fvg_hi         double precision NOT NULL,
  ext            double precision NOT NULL,
  ext_t          timestamptz      NOT NULL,
  close          double precision NOT NULL,
  spread         double precision NOT NULL,
  entry_ref      double precision NOT NULL,
  sl             double precision NOT NULL,
  tp             double precision NOT NULL,
  risk           double precision NOT NULL,
  rr             double precision NOT NULL,
  decision       text             NOT NULL CHECK (decision IN ('emir', 'atla')),
  reason         text             CHECK (reason IN ('hafta_sonu', 'donusum', 'haber', 'lot', 'golge', 'no_trade', 'gec', 'belirsiz_emir', 'emir_hatasi')),
  detail         jsonb,
  bars           text             CHECK (bars IN ('akis', 'resmi')),
  volume         double precision,
  risk_usd       double precision,
  sim_exit_at    timestamptz,
  sim_exit_kind  text             CHECK (sim_exit_kind IN ('TP', 'SL')),
  sim_r          double precision,
  decided_at     timestamptz      NOT NULL DEFAULT now(),
  computed_at    timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (mode, entry_t, side),
  CHECK ((decision = 'emir') = (reason IS NULL))
);
CREATE INDEX IF NOT EXISTS sdl_setups_day_idx ON sdl_setups (mode, day);

-- Emir niyetleri. Emir gönderilmeden ÖNCE yazılır (status SUBMITTING); sonuç gelince FILLED / REJECTED, belirsizse
-- UNKNOWN (zaman aşımı, ağ hatası, tanınmayan kod: emir gitmiş olabilir; tekrar gönderilmez, pozisyon clientId'yle
-- aranır). clientId PT_<10 karakter a-z0-9>_1; MetaApi SL/TP ile kapanan işlemlerde son parçayı değiştirebildiği için
-- eşleştirme ilk iki parçayla (client_key). Eski sistemin panel emirleri HK_ ile başlar.
CREATE TABLE IF NOT EXISTS sdl_orders (
  id               bigserial     PRIMARY KEY,
  setup_id         bigint        NOT NULL UNIQUE REFERENCES sdl_setups (id),
  client_id        varchar(26)   NOT NULL UNIQUE,
  client_key       varchar(24)   NOT NULL UNIQUE,
  magic            integer       NOT NULL,
  status           text          NOT NULL CHECK (status IN ('SUBMITTING', 'FILLED', 'REJECTED', 'UNKNOWN')),
  side             text          NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  volume           numeric(10,2) NOT NULL,
  risk_target_usd  numeric(10,2) NOT NULL,
  risk_usd         numeric(10,2) NOT NULL,
  sl               numeric(12,2) NOT NULL,
  tp               numeric(12,2) NOT NULL,
  bid              numeric(12,2) NOT NULL,
  ask              numeric(12,2) NOT NULL,
  quote_at         timestamptz   NOT NULL,
  mt5_order_id     varchar(32),
  mt5_position_id  varchar(32),
  fill_price       numeric(12,2),
  trade_code       varchar(40),
  trade_message    text,
  error            text,
  submitted_at     timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sdl_orders_created_idx ON sdl_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS sdl_orders_position_idx ON sdl_orders (mt5_position_id);

-- core'un SDL durumu (web'deki SDL sayfası için; tek satır): Railway'deki emir anahtarı ve ayarlar, fiyat akışının
-- durumu. core her 3m kapanışında yazar.
CREATE TABLE IF NOT EXISTS sdl_status (
  id                    smallint      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  trading_enabled       boolean       NOT NULL,
  magic                 integer       NOT NULL,
  risk_usd              numeric(10,2) NOT NULL,
  min_lot_max_risk_usd  numeric(10,2) NOT NULL,
  stream_state          text          NOT NULL,
  stream_error          text,
  last_quote_at         timestamptz,
  late_quotes           integer       NOT NULL DEFAULT 0,
  started_at            timestamptz   NOT NULL,
  updated_at            timestamptz   NOT NULL DEFAULT now()
);

-- NO TRADE düğmesi: enabled = false iken yeni emir açılmaz (kararlar yine yazılır, sebep no_trade); açık pozisyonlara
-- dokunulmaz, SL/TP'leriyle kalır. Web'deki SDL sayfasından değişir. Emir için ayrıca Railway'de
-- SDL_TRADING_ENABLED=true olmalı. Kapalı başlar.
CREATE TABLE IF NOT EXISTS trading_switch (
  strategy    text        PRIMARY KEY,
  enabled     boolean     NOT NULL DEFAULT false,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);
INSERT INTO trading_switch (strategy, enabled, note) VALUES ('sdl_elle', false, 'ilk kurulum') ON CONFLICT (strategy) DO NOTHING;
