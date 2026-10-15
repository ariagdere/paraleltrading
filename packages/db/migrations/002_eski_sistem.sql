-- 002: eski sistemden (hakari-dashboard veritabanı) kopyalanan işlemler.
--
-- Doğrulama ve ileri izleme için: strateji motoru naif kuralı geriye dönük oynatır ve eski sistemin gerçek
-- işlemleriyle (magic 7575 naif, 0 elle, 9100 panel...) karşılaştırır. Kopya tek yönlüdür, eski DB'ye yazılmaz.
-- Eski satır olduğu gibi data'da durur (to_jsonb); sorgu için birkaç sütun ayrıca tutulur.
-- Dosya tekrar çalıştırılabilir (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS legacy_orders (
  id          bigint      PRIMARY KEY, -- eski orders.id
  magic       integer     NOT NULL,
  status      text        NOT NULL,
  direction   text        NOT NULL,
  created_at  timestamptz NOT NULL,
  opened_at   timestamptz,
  closed_at   timestamptz,
  updated_at  timestamptz NOT NULL,
  data        jsonb       NOT NULL,
  copied_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legacy_orders_magic_opened_idx ON legacy_orders (magic, opened_at);

CREATE TABLE IF NOT EXISTS legacy_order_events (
  id          bigint      PRIMARY KEY, -- eski order_events.id
  order_id    bigint      NOT NULL,
  event_type  text        NOT NULL,
  event_time  timestamptz NOT NULL,
  data        jsonb       NOT NULL,
  copied_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legacy_order_events_order_idx ON legacy_order_events (order_id, event_time);
