-- 004: core'un heatmap snapshot'larından hesapladığı cluster'lar, bant likiditesi ve baz
--
-- Her heatmap snapshot'ı için bir satır (12h, 24h, 48h; collector'ın yazdıkları ve eski sistemden kopyalananlar).
-- Değer snapshot'ın received_at anında bilinir.
--
-- Cluster'lar eski sistemin kuralıyla (hakari-trigger-orchestrator, computeClusters): her fiyat seviyesinin bütün
-- sütunlardaki likidasyon toplamı alınır; referans fiyat heatmap'in son mumunun kapanışı; $1M altındaki seviyeler
-- dışarıda. Bir yöndeki en büyük seviye ve onun ±$300'ündeki seviyeler bir cluster: fiyatı likiditeyle ağırlıklı
-- ortalama, likiditesi toplam. up1 ve dn1 eski sistemin cluster'ıdır (eski sistem iki ondalığa yuvarlayıp
-- kullanıyordu, burada yuvarlanmadan). up2, up3 (dn2, dn3) aynı kuralın kalan seviyelerde tekrarı: her seferinde
-- kalanların en büyük seviyesinden. Sıra tepe seviyeye göre olduğu için bir sonraki cluster'ın toplamı daha büyük
-- olabilir (çok seviyeli bir küme, tek büyük seviyeden).
-- Bant likiditesi: referans fiyatın %1, %2, %3 yukarısına (aşağısına) kadarki bütün seviyelerin toplamı ($1M altı da).
-- Baz: referans fiyat − o anki Axi fiyatı. Axi fiyatı, snapshot'ın update_time'ına (yoksa received_at'ine) kadar
-- kapanmış son Axi 1m mumunun kapanışı (bid); son 5 dakikada mum yoksa boş. Heatmap fiyatıyla hesaplanan bir seviye
-- Axi'ye seviye − baz olarak taşınır.
-- ref_price boşsa snapshot'tan seviye çıkmadı (bozuk ya da boş çıktı); core onu yeniden denemez.
CREATE TABLE IF NOT EXISTS heatmap_levels (
  snapshot_id  bigint           PRIMARY KEY REFERENCES heatmap_snapshots (id) ON DELETE CASCADE,
  span         text             NOT NULL,
  received_at  timestamptz      NOT NULL,
  ref_price    double precision,
  axi_price    double precision,
  basis        double precision,
  up1_price    double precision,
  up1_usd      double precision,
  up2_price    double precision,
  up2_usd      double precision,
  up3_price    double precision,
  up3_usd      double precision,
  dn1_price    double precision,
  dn1_usd      double precision,
  dn2_price    double precision,
  dn2_usd      double precision,
  dn3_price    double precision,
  dn3_usd      double precision,
  up_liq_1pct  double precision,
  up_liq_2pct  double precision,
  up_liq_3pct  double precision,
  dn_liq_1pct  double precision,
  dn_liq_2pct  double precision,
  dn_liq_3pct  double precision,
  computed_at  timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS heatmap_levels_span_received_idx ON heatmap_levels (span, received_at);
