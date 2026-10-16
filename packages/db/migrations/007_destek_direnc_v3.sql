-- 007: destek/direnç v3: gösterilen bölgeler
--
-- v3'te core her 4h kapanışında hangi bölgelerin gösterileceğini de seçer: fiyatın ±%5'inde, üstte ve altta en
-- güçlü 3 bölge ve fiyatın içinde olduğu bölge; gösterilen bir bölgenin yerine ancak iki kat güçlü bir bölge geçer.
-- shown bölgenin şu an gösterilenlerden olup olmadığı; seçimin geçmişi olaylarda (shown, hidden).
-- v3'te bant sabit, resized olayı yazılmaz (v2 satırlarında kalır).
ALTER TABLE sr_zones ADD COLUMN IF NOT EXISTS shown boolean NOT NULL DEFAULT false;

ALTER TABLE sr_zone_events DROP CONSTRAINT IF EXISTS sr_zone_events_kind_check;
ALTER TABLE sr_zone_events ADD CONSTRAINT sr_zone_events_kind_check
  CHECK (kind IN ('created', 'resized', 'touch', 'hold', 'break', 'ended', 'shown', 'hidden'));
