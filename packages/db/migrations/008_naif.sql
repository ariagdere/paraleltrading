-- 008: naif kuralın yeniden oynatılması ve ileri izlemesi (doğrulama)
--
-- core, eski sistemin naif kuralını (hakari-trigger-orchestrator) her 12h heatmap snapshot'ında yeni sistemin
-- verisiyle uygular: cluster'lardan setup, karar anındaki ZLEMA 4h bölgesi ve eski sistemin o tarihteki penceresi
-- (9 Ekim'e kadar hafta içi, sonra pazartesi 00:00 – cuma 15:05).
-- Yön bölgeyle aynıysa ve döngü penceredeyse eski sistem emir gönderirdi (signal); işlem Axi 1m mumlarıyla
-- benzetilir. Eski sistemden fark: bölge Binance vadeli 4h yerine Axi 4h'ten (oluşan mum 1m'lerden).
-- Bir satır: bir sürümün bir snapshot'taki kararı ve (sinyalse) benzetilen işlem. Gerçek naif işlemlerle (eski
-- sistemin magic 7575 emirleri, legacy_orders) karşılaştırma web'de.
--
-- Zamanlar: cycle_at döngü anı (heatmap'in son sütunu), decided_at emrin verileceği an (cycle_at + 45 sn; eski
-- sistemde ölçülen gecikme). reason sinyal olmayan kararın ya da benzetilemeyen sinyalin nedeni:
--   seviye_yok (snapshot'tan seviye çıkmadı), cluster_yok (fiyatın iki yanında cluster yok), bolge_yok (4h geçmişi
--   yetmiyor), bolge_farkli (ZLEMA bölgesi yönle aynı değil), pencere_disi (hafta sonu ya da cuma 15:05 sonrası),
--   fiyat_yok (karar anında Axi mumu yok), gecersiz_seviye (TP ya da SL Axi fiyatının yanlış tarafında).
-- Fiyatlar: entry_ref, tp, sl heatmap (CoinGlass) fiyatı, eski sistemin gönderdiği gibi; entry_bid ve entry_price Axi
-- (BUY ask'tan, SELL bid'den). r_multiple girişe ve SL'e göre; mfe/mae girişten en iyi ve en kötü hareket ($).
-- Açık işlemde exit_* boş.

CREATE TABLE IF NOT EXISTS naive_decisions (
  version      text             NOT NULL,
  snapshot_id  bigint           NOT NULL REFERENCES heatmap_snapshots (id) ON DELETE CASCADE,
  cycle_at     timestamptz      NOT NULL,
  decided_at   timestamptz      NOT NULL,
  in_window    boolean          NOT NULL,
  ref_price    double precision,
  up_price     double precision,
  dn_price     double precision,
  basis        double precision,
  direction    text             CHECK (direction IN ('LONG', 'SHORT')),
  entry_ref    double precision,
  tp           double precision,
  sl           double precision,
  rr           double precision,
  zone_4h      text             CHECK (zone_4h IN ('LONG', 'SHORT', 'NO_TRADE')),
  aligned      boolean          NOT NULL,
  signal       boolean          NOT NULL,
  reason       text             CHECK (reason IN ('seviye_yok', 'cluster_yok', 'bolge_yok', 'bolge_farkli', 'pencere_disi', 'fiyat_yok', 'gecersiz_seviye')),
  entry_bid    double precision,
  entry_price  double precision,
  spread       double precision,
  exit_at      timestamptz,
  exit_reason  text             CHECK (exit_reason IN ('TP', 'SL')),
  exit_price   double precision,
  r_multiple   double precision,
  mfe          double precision,
  mae          double precision,
  ambiguous    boolean,
  computed_at  timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (version, snapshot_id)
);
CREATE INDEX IF NOT EXISTS naive_decisions_cycle_idx ON naive_decisions (version, cycle_at);
