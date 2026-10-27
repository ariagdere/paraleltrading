-- 009: kombinasyon simülasyonu (naif setup'ın değişken taraması) koşuları
--
-- core her ayın 1'inde 04:00'te (İstanbul) ve web'deki "Şimdi çalıştır" isteğiyle motoru çalıştırır: her 5m
-- kapanışında yakın cluster yönüne 75/75 setup (12h heatmap, yalnız bütün değişkenlerin dolu olduğu saatler),
-- long ve short ayrı ayrı ZLEMA, L/S açısı ve yakın/uzak cluster oranının 1–4'lü kombinasyonları, şans testi, en
-- iyi long ve en iyi short'un ayrı yuvalarda birleşimi; bir önceki aylık koşunun (yoksa bir önceki koşunun)
-- seçtiği kuralların arada geçen dönemdeki sonucu. Bütün çıktı results'ta (motor sürümü engine'de).
--
-- Koşu bitince sonucu paraleltrading reposunun sim-data dalına runs/<id>.json olarak yazılır; Claude rutini
-- yorumunu aynı dala yorum/<id>.json olarak koyar, core onu comment'e alır.
--
-- status: istendi (sırada), calisiyor, bitti, hata. kind: aylik (slot o ayın 1'i 04:00 İstanbul) ya da elle.
-- Aynı aylık slot için tek satır olur; elle istek sırada ya da çalışan koşu varken yenisini eklemez (web).

CREATE TABLE IF NOT EXISTS sim_runs (
  id              bigserial   PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('aylik', 'elle')),
  slot            timestamptz,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  status          text        NOT NULL DEFAULT 'istendi' CHECK (status IN ('istendi', 'calisiyor', 'bitti', 'hata')),
  started_at      timestamptz,
  finished_at     timestamptz,
  engine          text,
  data_from       timestamptz,
  data_to         timestamptz,
  previous_id     bigint      REFERENCES sim_runs (id) ON DELETE SET NULL,
  results         jsonb,
  error           text,
  git_path        text,
  git_commit      text,
  git_pushed_at   timestamptz,
  git_error       text,
  comment         jsonb,
  comment_sha     text,
  comment_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sim_runs_slot_uidx ON sim_runs (slot) WHERE slot IS NOT NULL;
CREATE INDEX IF NOT EXISTS sim_runs_requested_idx ON sim_runs (requested_at DESC);
