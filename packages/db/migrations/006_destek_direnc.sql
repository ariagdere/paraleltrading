-- 006: core'un Axi 4h ve 1d mumlarından hesapladığı destek/direnç bölgeleri ve olayları
--
-- Bölge, fiyatın birçok kez döndüğü ya da kapandığı fiyat aralığı. Kanıtlar ("izler"): 4h dönüş noktaları (iki
-- yanında 2 mum, ardından 12 mum içinde en az 1 ATR tepki), günlük ve haftalık tepe, dip ve kapanışlar. Her iz
-- bilindiği andan itibaren sayılır ve yarı ömürle zayıflar (4h 21 gün, 1d 30 gün, 1w 120 gün). Bölge, izlerin
-- fiyat ekseninde yoğunlaştığı yer; puanı bandındaki izlerin bugünkü ağırlıkları toplamı. Yeni bölge puan ≥ 3 ile
-- açılır, puanı 2'nin altına inince ya da daha güçlü bir bölgeyle örtüşünce biter. Kırılma (bandın 0,15 ATR
-- ötesinde 4h kapanışı) bölgeyi bitirmez, rolünü çevirir: destek dirence döner. Ayrıntı apps/core/src/zones.ts.
--
-- Hesap 4h kapanışlarında, yalnız o ana kadar bilinenle yapılır (as-of): created_at, ended_at ve olayların at'i bir
-- 4h kapanışıdır, o anda bilinen. Hepsi axi_candles'tan yeniden üretilebilir: 4h ya da 1d mumu düzeltilirse ya da
-- araya mum eklenirse core bütün geçmişi yeniden oynatır, yalnız değişen satırları yazar.
--
-- version algoritmanın ve parametrelerin sürümü; parametreler sr_versions'ta. Algoritma ya da parametre değişince
-- yeni sürüm açılır, eski sürümün satırları olduğu gibi kalır (o sürümün son hesabı).
CREATE TABLE IF NOT EXISTS sr_versions (
  version     text        PRIMARY KEY,
  params      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Bölgenin son durumu. lo, hi ve puanlar son hesaptaki (bittiyse bittiği andaki) değerler; bandın ve puanın
-- zaman içindeki hali olaylarda ve score_at/score_value'da. score_4h/1d/1w puanın dilimlere dağılımı: bölgenin
-- hangi dilimin izlerinden oluştuğu.
CREATE TABLE IF NOT EXISTS sr_zones (
  symbol       text               NOT NULL,
  version      text               NOT NULL REFERENCES sr_versions (version),
  zone_id      integer            NOT NULL, -- sürüm içinde oluşma sırası
  created_at   timestamptz        NOT NULL, -- bölgenin ilk bilindiği 4h kapanışı
  ended_at     timestamptz,                 -- bittiği 4h kapanışı; sürüyorsa boş
  end_reason   text,
  lo           double precision   NOT NULL,
  hi           double precision   NOT NULL,
  score        double precision   NOT NULL,
  score_4h     double precision   NOT NULL,
  score_1d     double precision   NOT NULL,
  score_1w     double precision   NOT NULL,
  touches      integer            NOT NULL,
  holds        integer            NOT NULL,
  breaks       integer            NOT NULL,
  score_at     timestamptz[]      NOT NULL, -- puan geçmişi: oluşunca ve %15'ten çok değişince
  score_value  double precision[] NOT NULL,
  computed_at  timestamptz        NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, version, zone_id)
);
CREATE INDEX IF NOT EXISTS sr_zones_active_idx ON sr_zones (symbol, version) WHERE ended_at IS NULL;

-- Olaylar: created (oluştu), resized (bant 0,25 ATR'den çok değişti), touch (en az 0,6 ATR uzaktan gelip banda
-- girdi), hold (testten sonra aynı yana 1 ATR uzaklaştı: tuttu), break (bandın 0,15 ATR ötesinde kapandı: kırıldı,
-- rol döndü), ended (bitti). price olay anındaki fiyat (touch'ta banda giren fitil, hold'da uzaklaşan fitil,
-- diğerlerinde 4h kapanışı); lo, hi ve score olay anındaki bant ve puan.
CREATE TABLE IF NOT EXISTS sr_zone_events (
  symbol   text             NOT NULL,
  version  text             NOT NULL,
  zone_id  integer          NOT NULL,
  seq      integer          NOT NULL, -- bölge içinde olay sırası
  at       timestamptz      NOT NULL,
  kind     text             NOT NULL CHECK (kind IN ('created', 'resized', 'touch', 'hold', 'break', 'ended')),
  price    double precision NOT NULL,
  lo       double precision NOT NULL,
  hi       double precision NOT NULL,
  score    double precision NOT NULL,
  note     text,
  PRIMARY KEY (symbol, version, zone_id, seq),
  FOREIGN KEY (symbol, version, zone_id) REFERENCES sr_zones (symbol, version, zone_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sr_zone_events_at_idx ON sr_zone_events (symbol, version, at);
