// SDL v3, elle zonlar (Ari, 18 Kasım): fiyat akışı, canlı karar, emir kapısı ve geçmişin yeniden oynatması.
// Ayrıntı: docs/sdl.md. core'un kilidi alındıktan sonra başlar (tek core → çift emir yok).

import { every, type Job, type Pool } from '@pt/db'
import { loadSdlConfig, type SdlConfig } from './config.js'
import { SdlLive } from './live.js'
import { replayTick } from './replay.js'
import { PriceStream } from './stream.js'
import { Trader } from './trader.js'

const MINUTE = 60_000

export function startSdl(pool: Pool, symbol: string): Job[] {
  let cfg: SdlConfig
  try {
    cfg = loadSdlConfig()
  } catch (err) {
    console.error(`[sdl] ayarlar hatalı, SDL kapalı: ${(err as Error).message}`)
    return []
  }
  const stream = cfg.metaapiReady ? new PriceStream(pool, cfg.metaapi, symbol) : null
  stream?.start()
  const trader = new Trader(pool, cfg, stream, symbol)
  const live = new SdlLive(pool, cfg, stream, trader, symbol)
  live.start()
  const firstReplay = replayTick(pool, cfg, symbol)
  const replay = every('sdl-tekrar', 60 * MINUTE, 50 * MINUTE, () => replayTick(pool, cfg, symbol))
  console.log(
    `[sdl] başladı: emir ${cfg.tradingEnabled ? 'açık (NO TRADE düğmesine bağlı)' : 'kapalı (gölge: kararlar yazılır, emir gitmez)'}, ` +
      `magic ${cfg.magic}, risk ${cfg.riskUsd} $ (en küçük lotta en çok ${cfg.minLotMaxRiskUsd} $), fiyat akışı ${stream ? 'var' : 'yok (MetaApi değişkenleri tanımlı değil)'}`,
  )
  return [
    {
      stop: () => {
        live.stop()
        void stream?.stop()
      },
      idle: () => Promise.all([live.idle(), firstReplay]).then(() => undefined),
    },
    replay,
  ]
}
