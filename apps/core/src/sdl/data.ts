// SDL'nin veritabanı okumaları: elle zonlar, Axi mumları (collector'ın resmi mumları), günlük bias, haber takvimi
// (kırmızı klasör; eski DB'den saatte bir kopyalanıyor), sembol bilgisi, NO TRADE düğmesi.

import type { Pool } from '@pt/db'
import { istDay, type Bar, type Bar4, type BiasReport, type Zone } from './engine.js'
import { specFrom, type Spec } from './sizing.js'

const ms = (d: Date) => d.getTime()

export async function loadZones(pool: Pool): Promise<Zone[]> {
  const { rows } = await pool.query<{ id: number; lo: number; hi: number; created_at: Date; ended_at: Date | null }>(
    'SELECT id, lo, hi, created_at, ended_at FROM elle_zones ORDER BY id',
  )
  return rows.map((r) => ({ id: r.id, lo: r.lo, hi: r.hi, createdAt: ms(r.created_at), endedAt: r.ended_at ? ms(r.ended_at) : null }))
}

type CandleRow = { t: string; o: number; h: number; l: number; c: number; sp: number | null; u: Date }

const COLS = `(extract(epoch FROM open_time) * 1000)::bigint::text AS t, open AS o, high AS h, low AS l, close AS c, spread_points AS sp, updated_at AS u`

// 1m mumları, açılışı [from, to) aralığında. updated: collector'ın son yazdığı an (resmi mumun kesinleşmesi için).
export async function loadM1(pool: Pool, symbol: string, from: number, to: number): Promise<Array<Bar & { updated: number }>> {
  const { rows } = await pool.query<CandleRow>(
    `SELECT ${COLS} FROM axi_candles WHERE symbol = $1 AND timeframe = '1m' AND open_time >= $2 AND open_time < $3 ORDER BY open_time`,
    [symbol, new Date(from), new Date(to)],
  )
  return rows.map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c, sp: r.sp, updated: ms(r.u) }))
}

export async function load4h(pool: Pool, symbol: string, from: number): Promise<Array<Bar4 & { updated: number }>> {
  const { rows } = await pool.query<CandleRow>(
    `SELECT ${COLS} FROM axi_candles WHERE symbol = $1 AND timeframe = '4h' AND open_time >= $2 ORDER BY open_time`,
    [symbol, new Date(from)],
  )
  return rows.map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c, updated: ms(r.u) }))
}

// Günlük mumu olan İstanbul günleri (önceki günün mumu yoksa araştırmadaki gibi o gün taranmaz).
export async function loadDailyDays(pool: Pool, symbol: string, from: number): Promise<Set<string>> {
  const { rows } = await pool.query<{ t: Date }>(
    `SELECT open_time AS t FROM axi_candles WHERE symbol = $1 AND timeframe = '1d' AND open_time >= $2`,
    [symbol, new Date(from)],
  )
  return new Set(rows.map((r) => istDay(ms(r.t))))
}

// Günlük bias raporları, run_date'e göre; at = raporun üretildiği an (generated_at). Canlı kararda tabloya düşmüş
// raporlar kullanılır; tekrarda araştırmadaki gibi üretildiği andan itibaren geçerli.
export async function loadBias(pool: Pool, fromDay: string, toDay: string): Promise<Map<string, BiasReport[]>> {
  const { rows } = await pool.query<{ run_date: string; generated_at: Date; bias: string }>(
    `SELECT run_date, generated_at, bias FROM daily_bias WHERE run_date BETWEEN $1 AND $2 ORDER BY run_date, generated_at`,
    [fromDay, toDay],
  )
  const out = new Map<string, BiasReport[]>()
  for (const r of rows) {
    const list = out.get(r.run_date) ?? []
    list.push({ at: ms(r.generated_at), bias: r.bias })
    out.set(r.run_date, list)
  }
  return out
}

export async function loadNews(pool: Pool, from: number, to: number): Promise<number[]> {
  const { rows } = await pool.query<{ t: Date }>(
    'SELECT DISTINCT event_at AS t FROM calendar_events WHERE event_at BETWEEN $1 AND $2 ORDER BY event_at',
    [new Date(from), new Date(to)],
  )
  return rows.map((r) => ms(r.t))
}

export async function loadSpec(pool: Pool, symbol: string): Promise<Spec | null> {
  const { rows } = await pool.query<{ spec: unknown }>(
    'SELECT spec FROM axi_symbol_spec WHERE symbol = $1 ORDER BY captured_at DESC LIMIT 1',
    [symbol],
  )
  return rows[0] ? specFrom(rows[0].spec) : null
}

export async function switchOn(pool: Pool, strategy: string): Promise<boolean> {
  const { rows } = await pool.query<{ enabled: boolean }>('SELECT enabled FROM trading_switch WHERE strategy = $1', [strategy])
  return rows[0]?.enabled === true
}
