import { db } from './db'

// SDL sayfasının verisi: core'un durumu (sdl_status), NO TRADE düğmesi, sağlık satırları, canlı kararlar (emir ve eski
// sistemdeki kaydıyla: legacy_orders, saatte bir kopyalanıyor), geçmişin tekrarı ve elle zonlar.

export type SdlStatus = {
  tradingEnabled: boolean
  magic: number
  riskUsd: number
  minLotMaxRiskUsd: number
  streamState: string
  streamError: string | null
  lastQuoteAt: Date | null
  lateQuotes: number
  startedAt: Date
  updatedAt: Date
}

export type SdlHealth = { source: string; lastSourceTime: Date | null; lastSuccessAt: Date | null; failures: number; lastError: string | null; lastErrorAt: Date | null }

export type SdlRow = {
  id: number
  mode: 'canli' | 'tekrar'
  entryT: Date
  day: string
  side: 'LONG' | 'SHORT'
  zoneId: number
  tpZoneId: number
  entryRef: number
  sl: number
  tp: number
  risk: number
  rr: number
  decision: 'emir' | 'atla'
  reason: string | null
  detail: Record<string, unknown> | null
  bars: string | null
  volume: number | null
  riskUsd: number | null
  simExitAt: Date | null
  simExitKind: 'TP' | 'SL' | null
  simR: number | null
  order: null | {
    status: string
    volume: number
    riskUsd: number
    positionId: string | null
    fillPrice: number | null
    code: string | null
    message: string | null
    error: string | null
    // eski sistemdeki kayıt (legacy_orders); kopya saatte bir
    legacyStatus: string | null
    closedAt: Date | null
    exitReason: string | null
    realizedPnl: number | null
    legacyFill: number | null
    legacySl: number | null
    legacyVolume: number | null
  }
}

export type SdlZone = { id: number; lo: number; hi: number; createdAt: Date; endedAt: Date | null; note: string | null }

export type SdlData = {
  now: Date
  status: SdlStatus | null
  switchOn: boolean
  switchChangedAt: Date | null
  health: SdlHealth[]
  live: SdlRow[]
  replay: SdlRow[]
  zones: SdlZone[]
}

const LIVE_DAYS = 14
const num = (x: unknown) => (x === null || x === undefined ? null : Number(x))

function toRow(r: any): SdlRow {
  return {
    id: Number(r.id),
    mode: r.mode,
    entryT: r.entry_t,
    day: r.day,
    side: r.side,
    zoneId: r.zone_id,
    tpZoneId: r.tp_zone_id,
    entryRef: r.entry_ref,
    sl: r.sl,
    tp: r.tp,
    risk: r.risk,
    rr: r.rr,
    decision: r.decision,
    reason: r.reason,
    detail: r.detail,
    bars: r.bars,
    volume: r.volume,
    riskUsd: r.risk_usd,
    simExitAt: r.sim_exit_at,
    simExitKind: r.sim_exit_kind,
    simR: r.sim_r,
    order:
      r.o_status === null || r.o_status === undefined
        ? null
        : {
            status: r.o_status,
            volume: Number(r.o_volume),
            riskUsd: Number(r.o_risk_usd),
            positionId: r.o_position_id,
            fillPrice: num(r.o_fill),
            code: r.o_code,
            message: r.o_message,
            error: r.o_error,
            legacyStatus: r.l_status,
            closedAt: r.l_closed_at ? new Date(r.l_closed_at) : null,
            exitReason: r.l_exit_reason,
            realizedPnl: num(r.l_pnl),
            legacyFill: num(r.l_fill),
            legacySl: num(r.l_sl),
            legacyVolume: num(r.l_volume),
          },
  }
}

const SETUP_COLS = `s.id, s.mode, s.entry_t, s.day, s.side, s.zone_id, s.tp_zone_id, s.entry_ref, s.sl, s.tp, s.risk, s.rr, s.decision,
  s.reason, s.detail, s.bars, s.volume, s.risk_usd, s.sim_exit_at, s.sim_exit_kind, s.sim_r`

export async function loadSdl(): Promise<SdlData> {
  const pool = db()
  const [status, sw, health, live, replay, zones, now] = await Promise.all([
    pool.query(`SELECT * FROM sdl_status WHERE id = 1`),
    pool.query(`SELECT enabled, changed_at FROM trading_switch WHERE strategy = 'sdl_elle'`),
    pool.query(
      `SELECT source, last_source_time, last_success_at, consecutive_failures, last_error, last_error_at FROM collector_status WHERE source LIKE 'sdl:%' ORDER BY source`,
    ),
    pool.query(
      `SELECT ${SETUP_COLS}, o.status AS o_status, o.volume AS o_volume, o.risk_usd AS o_risk_usd, o.mt5_position_id AS o_position_id,
              o.fill_price AS o_fill, o.trade_code AS o_code, o.trade_message AS o_message, o.error AS o_error,
              l.status AS l_status, l.closed_at AS l_closed_at, l.data->>'exit_reason' AS l_exit_reason, l.data->>'realized_pnl' AS l_pnl,
              l.data->>'fill_price' AS l_fill, l.data->>'sl' AS l_sl, l.data->>'volume' AS l_volume
       FROM sdl_setups s
       LEFT JOIN sdl_orders o ON o.setup_id = s.id
       LEFT JOIN LATERAL (
         SELECT lo.status, lo.closed_at, lo.data FROM legacy_orders lo
         WHERE o.mt5_position_id IS NOT NULL AND lo.data->>'mt5_position_id' = o.mt5_position_id ORDER BY lo.id DESC LIMIT 1
       ) l ON true
       WHERE s.mode = 'canli' AND s.entry_t > now() - $1::interval
       ORDER BY s.entry_t DESC`,
      [`${LIVE_DAYS} days`],
    ),
    pool.query(`SELECT ${SETUP_COLS} FROM sdl_setups s WHERE s.mode = 'tekrar' ORDER BY s.entry_t DESC`),
    pool.query(`SELECT id, lo, hi, created_at, ended_at, note FROM elle_zones ORDER BY lo DESC`),
    pool.query<{ now: Date }>('SELECT now() AS now'),
  ])
  const st = status.rows[0]
  return {
    now: now.rows[0]!.now,
    status: st
      ? {
          tradingEnabled: st.trading_enabled,
          magic: st.magic,
          riskUsd: Number(st.risk_usd),
          minLotMaxRiskUsd: Number(st.min_lot_max_risk_usd),
          streamState: st.stream_state,
          streamError: st.stream_error,
          lastQuoteAt: st.last_quote_at,
          lateQuotes: st.late_quotes,
          startedAt: st.started_at,
          updatedAt: st.updated_at,
        }
      : null,
    switchOn: sw.rows[0]?.enabled === true,
    switchChangedAt: sw.rows[0]?.changed_at ?? null,
    health: health.rows.map((r) => ({
      source: r.source,
      lastSourceTime: r.last_source_time,
      lastSuccessAt: r.last_success_at,
      failures: r.consecutive_failures,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at,
    })),
    live: live.rows.map(toRow),
    replay: replay.rows.map(toRow),
    zones: zones.rows.map((r) => ({ id: r.id, lo: r.lo, hi: r.hi, createdAt: r.created_at, endedAt: r.ended_at, note: r.note })),
  }
}
