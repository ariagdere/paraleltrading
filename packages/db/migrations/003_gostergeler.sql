-- 003: core'un Axi mumlarından hesapladığı göstergeler
--
-- Her satır kapanmış bir Axi mumunun göstergeleri (15m, 1h, 4h, 1d). Değer mum kapanınca (open_time + dilim)
-- bilinir. Hepsi axi_candles'tan yeniden üretilebilir: mum sonradan düzeltilirse ya da araya mum eklenirse core
-- o mumdan sonrasını yeniden hesaplar. src_updated_at, hesapta kullanılan mumun axi_candles.updated_at değeridir;
-- düzeltmeyi yakalamak için tutulur.
--
-- ZLEMA bölgesi eski sistemin formülüyle (hakari-trigger-orchestrator): hlc3 → Kalman → ZLEMA(8) (zlema_fast) ve
-- ZLEMA(21) (zlema_slow). Eski sistem her hesapta son 150 mumu kullanıyordu ve Kalman'ın başlangıç değeri yüzünden
-- sonuç pencereye bağlı; bu yüzden her mum o muma kadarki son 150 mumla hesaplanır. LONG: hızlı > yavaş ve hızlı
-- son iki mumdur yükseliyor; SHORT: tersi; ikisi de değilse NO_TRADE. Dilimde 150 mumdan azı varsa boş.
-- RSI ve ATR 14, Wilder ortalamasıyla (TradingView'deki gibi): ilk 14 değerin düz ortalamasıyla başlar, serinin
-- başından yürür.
CREATE TABLE IF NOT EXISTS axi_indicators (
  symbol          text             NOT NULL,
  timeframe       text             NOT NULL CHECK (timeframe IN ('15m', '1h', '4h', '1d')),
  open_time       timestamptz      NOT NULL,
  zlema_fast      double precision,
  zlema_slow      double precision,
  zlema_zone      text             CHECK (zlema_zone IN ('LONG', 'SHORT', 'NO_TRADE')),
  rsi14           double precision,
  atr14           double precision,
  src_updated_at  timestamptz      NOT NULL,
  computed_at     timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, open_time)
);
