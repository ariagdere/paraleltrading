-- 001: ham veri ve işletim tabloları
--
-- Kurallar
--   * Bütün zamanlar UTC (timestamptz). İstanbul saati yalnız ekranda kullanılır.
--   * Ham tablolar yalnız eklenir; aynı anahtar tekrar gelirse güncellenir ya da atlanır (idempotent).
--   * Türetilmiş her şey (göstergeler, açılar, cluster'lar) bu tablolardan yeniden üretilir.
--   * Geriye dönük simülasyonda "o an ne biliniyordu" ölçütü tabloya göre:
--       mum      kapanış anı (open_time + dilim)
--       L/S      ts + canlı satırlardan ölçülen yayın gecikmesi (received_at - ts)
--       heatmap  received_at
--       bias     committed_at
--     received_at her tabloda verinin bize ulaştığı andır; geriye dolgu satırlarında yalnız bilgi amaçlıdır.
--   * Dosya tekrar çalıştırılabilir (IF NOT EXISTS); DBeaver'da elle çalıştırmak da zararsızdır.
--     Bir kez uygulandıktan sonra bu dosya değiştirilmez; değişiklikler 002, 003 ... dosyalarıyla gelir.

-- Axi mumları: 1m, 5m, 15m, 1h, 4h, 1d, Axi'nin kendi sınırlarıyla. Gün 21:00 UTC'de (İstanbul 00:00)
-- başlar; eski veride 2024'ten bu yana yaz/kış kayması yok. Yalnız kapanmış mumlar yazılır.
-- Fiyatlar bid. spread_points mumun spread alanıdır (MT5'te puan cinsinden); ask yaklaşık
-- bid + spread_points × point, point değeri axi_symbol_spec'te.
CREATE TABLE IF NOT EXISTS axi_candles (
  symbol         text             NOT NULL,
  timeframe      text             NOT NULL CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  open_time      timestamptz      NOT NULL,
  open           double precision NOT NULL,
  high           double precision NOT NULL,
  low            double precision NOT NULL,
  close          double precision NOT NULL,
  tick_volume    bigint,
  spread_points  integer,
  source         text             NOT NULL DEFAULT 'metaapi' CHECK (source IN ('metaapi', 'old_db')),
  received_at    timestamptz      NOT NULL DEFAULT now(),
  updated_at     timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, open_time)
);

-- Sembol bilgisi (digits, point, lot adımı, kontrat büyüklüğü, swap...). Değiştiğinde yeni satır yazılır.
CREATE TABLE IF NOT EXISTS axi_symbol_spec (
  symbol       text        NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  spec_hash    text        NOT NULL,
  spec         jsonb       NOT NULL,
  PRIMARY KEY (symbol, captured_at)
);

-- Binance L/S oranları, yalnız 5m: global (hesap oranı) ve top_position (TT pozisyon oranı).
-- 1h ve diğer dilimler bu seriden türetilir: eski veride Binance'in 1h noktası aynı zamandaki 5m noktasıyla
-- birebir aynı (1030 saatin hepsi). Binance geriye yalnız son 30 günü verdiği için bu seri kaybedilirse geri gelmez.
CREATE TABLE IF NOT EXISTS lsr_series (
  metric            text             NOT NULL CHECK (metric IN ('global', 'top_position')),
  ts                timestamptz      NOT NULL,
  long_account      double precision,
  short_account     double precision,
  long_short_ratio  double precision NOT NULL,
  source            text             NOT NULL DEFAULT 'binance' CHECK (source IN ('binance', 'old_db')),
  received_at       timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (metric, ts)
);

-- Likidasyon heatmap'i (CoinGlass model1, Apify aktörü): her çalıştırmanın çıktısı olduğu gibi, JSON metni
-- gzip'lenmiş halde. jsonb aynı veri için 4-5 kat yer tutuyor; 3 pencere saatte bir çalışınca fark yılda
-- birkaç GB. Okuma: gunzip + JSON.parse. Hızlı bakış için özet sütunlar ayrı tutulur.
-- Snapshot'lar birleştirilmez; aynı zamanın sütunu sonraki snapshot'ta farklı olabilir. Geçmişi sonradan çekilemez.
CREATE TABLE IF NOT EXISTS heatmap_snapshots (
  id              bigserial   PRIMARY KEY,
  span            text        NOT NULL CHECK (span IN ('12h', '24h', '48h')),
  model           text        NOT NULL DEFAULT 'model1',
  symbol          text        NOT NULL DEFAULT 'BTC',
  apify_run_id    text        UNIQUE,
  run_started_at  timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  update_time     timestamptz,
  first_col_time  timestamptz,
  last_col_time   timestamptz,
  n_cols          integer,
  n_levels        integer,
  n_cells         integer,
  payload_gz      bytea       NOT NULL,
  source          text        NOT NULL DEFAULT 'collector' CHECK (source IN ('collector', 'old_db'))
);
CREATE INDEX IF NOT EXISTS heatmap_snapshots_span_received_idx ON heatmap_snapshots (span, received_at);
-- CoinGlass veriyi yenilememişse (aynı updateTime) ikinci kez yazılmaz.
CREATE UNIQUE INDEX IF NOT EXISTS heatmap_snapshots_span_update_uidx
  ON heatmap_snapshots (span, update_time) WHERE update_time IS NOT NULL;

-- Red folder takvimi (yılda bir Excel'den içe aktarılır).
CREATE TABLE IF NOT EXISTS calendar_events (
  id          bigserial   PRIMARY KEY,
  event_at    timestamptz NOT NULL,
  currency    text        NOT NULL,
  event_name  text        NOT NULL,
  source      text        NOT NULL DEFAULT 'excel' CHECK (source IN ('excel', 'old_db')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_at, currency, event_name)
);

-- Günlük bias: Claude rutininin bias-data dalına yazdığı raporlar, dosya başına bir satır.
-- committed_at, raporun dala düştüğü an. Etiketler eski ingest'teki gibi normalize edilir; dosyanın tamamı raw'da durur.
CREATE TABLE IF NOT EXISTS daily_bias (
  source_file          text        PRIMARY KEY,
  commit_sha           text        NOT NULL,
  committed_at         timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  run_date             date        NOT NULL,
  generated_at         timestamptz NOT NULL,
  bias                 text        NOT NULL CHECK (bias IN ('LONG', 'NEUTRAL', 'SHORT')),
  confidence           text        NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  net_direction        text        NOT NULL,
  net_direction_level  smallint    NOT NULL CHECK (net_direction_level BETWEEN -3 AND 3),
  sentiment_score      smallint    NOT NULL CHECK (sentiment_score BETWEEN -100 AND 100),
  change_24h           text        CHECK (change_24h IN ('IMPROVED', 'UNCHANGED', 'WORSENED')),
  liquidity_regime     text        CHECK (liquidity_regime IN ('TIGHTENING', 'NEUTRAL', 'EASING', 'STRONG_EXPANSION')),
  risk_regime          text        CHECK (risk_regime IN ('RISK_ON', 'CAUTIOUS_RISK_ON', 'NEUTRAL', 'CAUTIOUS_RISK_OFF', 'RISK_OFF')),
  divergence           text        CHECK (divergence IN ('RELATIVE_STRENGTH', 'RELATIVE_WEAKNESS', 'ALIGNED')),
  divergence_note      text,
  key_development      text,
  conclusion           text,
  drivers              jsonb,
  developments         jsonb,
  asset_strength       jsonb,
  raw_text             text,
  model                text,
  prompt_version       text,
  raw                  jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS daily_bias_committed_at_idx ON daily_bias (committed_at);

-- Toplayıcı sağlığı: kaynak başına son durum (ör. 'axi_candles:1m', 'lsr:global', 'heatmap:12h', 'bias').
CREATE TABLE IF NOT EXISTS collector_status (
  source                text        PRIMARY KEY,
  expected_every        interval    NOT NULL,
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_source_time      timestamptz,
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  last_error            text,
  last_error_at         timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Çalıştırma kaydı: her heatmap çalıştırması (maliyetiyle) ve her hata. Sık işlerin (1m mum, 5m L/S)
-- başarılı turları buraya yazılmaz; onların son durumu collector_status'ta.
CREATE TABLE IF NOT EXISTS collector_runs (
  id            bigserial      PRIMARY KEY,
  source        text           NOT NULL,
  started_at    timestamptz    NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  ok            boolean,
  rows_written  integer,
  cost_usd      numeric(10, 4),
  detail        jsonb,
  error         text
);
CREATE INDEX IF NOT EXISTS collector_runs_source_started_idx ON collector_runs (source, started_at DESC);
