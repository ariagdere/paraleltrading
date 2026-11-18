import { db, dbWrite } from './db'
import { SYMBOL } from './market-data'
import {
  ZONE_DEFAULT_BREAKS_FROM, ZONE_MAX_DIST_PCT, ZONE_MAX_WIDTH, ZONE_MIN_WIDTH, roundPrice, zoneConflicts, zoneThreshold,
  type ZoneConflict, type ZoneRule, type ZoneSaveRequest,
} from './zone-rules'

// Elle zonları yazma: Piyasa grafiğinden (oturumla) ve eski sistemin /live grafiğinden (sunucudan sunucuya, gizli
// anahtarla; ZONE_API_TOKEN). Kurallar lib/zone-rules.ts'te; burada aynı kurallar tek transaction'da yeniden denetlenir.
// - Ekleme: yeni numara (en büyük numara + 1), kaydedildiği andan geçerli. Kırılma takibi seçilen tarihten (varsayılan
//   1 Eylül 2026 00:00 İstanbul).
// - Düzenleme: yeni numaralı zon; eskisi aynı anda kapanır (end_reason duzenleme), kırılma takibi eskisinin
//   başlangıcından devam eder.
// - Çakışma: kullanıcının gördüğü çakışmalar sunucudakiyle aynı değilse (arada başka ekrandan zon eklendiyse) kaydedilmez;
//   onaylananlar kapanır (cakisma).
// - Pasife alma: yalnız kapanır (kapatma).
// Yazarken tablo kilitlenir (aynı anda iki kayıt numara ya da çakışma yarışına girmesin); okumalar beklemez. Kilit
// alındıktan sonraki an (clock_timestamp) hem karşılaştırmada hem yazmada kullanılır: sıradaki yazan öncekinin
// yazdığını hep görür.
// SDL zonları dakikada bir okur: değişiklik en geç 1 dakikada kararlara girer.

export type ZoneSource = 'piyasa' | 'live'

export class ZoneWriteError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
    public conflicts?: ZoneConflict[],
  ) {
    super(message)
  }
}

const MIN_HARD_WIDTH = 1 // $: bundan dar zon kaydedilmez (uyarı değil, hata)

export async function loadZoneRule(): Promise<ZoneRule> {
  const { rows } = await db().query<{ atr: number | null; price: number | null }>(
    `SELECT (SELECT atr14 FROM axi_indicators WHERE symbol = $1 AND timeframe = '4h' AND atr14 IS NOT NULL
              ORDER BY open_time DESC LIMIT 1) AS atr,
            (SELECT close FROM axi_candles WHERE symbol = $1 AND timeframe = '1m' ORDER BY open_time DESC LIMIT 1) AS price`,
    [SYMBOL],
  )
  const atr = rows[0]?.atr ?? null
  return {
    threshold: zoneThreshold(atr),
    atr: atr === null ? null : Math.round(atr),
    price: rows[0]?.price ?? null,
    minWidth: ZONE_MIN_WIDTH,
    maxWidth: ZONE_MAX_WIDTH,
    maxDistPct: ZONE_MAX_DIST_PCT,
    defaultBreaksFrom: ZONE_DEFAULT_BREAKS_FROM,
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const ids = (v: unknown): number[] | null => (Array.isArray(v) && v.every(isInt) ? [...new Set(v as number[])] : null)

// Gövdeyi doğrular; fiyatlar kuruşa yuvarlanır.
export function parseSaveRequest(body: unknown): ZoneSaveRequest {
  const b = (body ?? {}) as Record<string, unknown>
  const lo = typeof b.lo === 'number' ? roundPrice(b.lo) : NaN
  const hi = typeof b.hi === 'number' ? roundPrice(b.hi) : NaN
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi - lo < MIN_HARD_WIDTH) {
    throw new ZoneWriteError(400, `Alt ve üst fiyat sayı olmalı, üst alttan en az ${MIN_HARD_WIDTH} $ büyük`)
  }
  const editId = b.editId === undefined || b.editId === null ? null : isInt(b.editId) ? b.editId : NaN
  if (Number.isNaN(editId)) throw new ZoneWriteError(400, 'Düzenlenen zonun numarası geçersiz')
  const seen = ids(b.seen ?? [])
  const end = ids(b.end ?? [])
  if (!seen || !end) throw new ZoneWriteError(400, 'Çakışan zonların numaraları geçersiz')
  let breaksFrom: string | null = null
  if (b.breaksFrom !== undefined && b.breaksFrom !== null) {
    const t = typeof b.breaksFrom === 'string' ? Date.parse(b.breaksFrom) : NaN
    if (!Number.isFinite(t) || t > Date.now()) throw new ZoneWriteError(400, 'Kırılma takibinin başlangıcı geçmişte bir tarih olmalı')
    breaksFrom = new Date(t).toISOString()
  }
  return { lo, hi, editId, seen, end, breaksFrom }
}

type Row = { id: number; lo: number; hi: number; created_at: Date; breaks_from: Date | null }
type Client = { query: ReturnType<typeof dbWrite>['query'] }

async function lockedNow(client: Client): Promise<Date> {
  const { rows } = await client.query<{ t: Date }>('SELECT clock_timestamp() AS t')
  return rows[0]!.t
}
const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x))

export type SavedZone = { id: number; lo: number; hi: number; createdAt: number; breaksFrom: number; replaces: number[] }

export async function saveZone(req: ZoneSaveRequest, source: ZoneSource): Promise<{ zone: SavedZone; ended: number[] }> {
  const rule = await loadZoneRule()
  const client = await dbWrite().connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE elle_zones IN SHARE ROW EXCLUSIVE MODE')
    const at = await lockedNow(client)
    const { rows: active } = await client.query<Row>(
      `SELECT id, lo, hi, created_at, breaks_from FROM elle_zones
        WHERE created_at <= $1 AND (ended_at IS NULL OR ended_at > $1) ORDER BY id`,
      [at],
    )
    const edited = req.editId ? active.find((z) => z.id === req.editId) : undefined
    if (req.editId && !edited) throw new ZoneWriteError(404, `#${req.editId} artık geçerli değil (başka bir ekrandan değişmiş olabilir)`)
    const conflicts = zoneConflicts(active, req.lo, req.hi, rule.threshold, req.editId ?? null)
    if (!sameSet(conflicts.map((c) => c.id), req.seen)) {
      throw new ZoneWriteError(409, 'Zonlar değişmiş; çakışmalar yeniden gösterildi', conflicts)
    }
    if (!req.end.every((id) => conflicts.some((c) => c.id === id))) throw new ZoneWriteError(400, 'Pasife alınacak zon çakışanlardan değil')

    const breaksFrom = edited ? (edited.breaks_from ?? edited.created_at) : new Date(req.breaksFrom ?? ZONE_DEFAULT_BREAKS_FROM)
    const replaces = [...(edited ? [edited.id] : []), ...req.end]
    const { rows: idRow } = await client.query<{ id: number }>('SELECT COALESCE(max(id), 0) + 1 AS id FROM elle_zones')
    const id = idRow[0]!.id
    const note = `${source === 'live' ? '/live' : 'Piyasa'}${edited ? `, #${edited.id} düzenlendi` : ''}`
    const { rows: ins } = await client.query<{ created_at: Date; breaks_from: Date }>(
      `INSERT INTO elle_zones (id, lo, hi, created_at, breaks_from, replaces, source, note)
       VALUES ($1, $2, $3, $8, LEAST($4::timestamptz, $8), $5, $6, $7)
       RETURNING created_at, breaks_from`,
      [id, req.lo, req.hi, breaksFrom, replaces.length > 0 ? replaces : null, source, note, at],
    )
    if (replaces.length > 0) {
      await client.query(
        `UPDATE elle_zones
            SET ended_at = $4, replaced_by = $1, end_reason = CASE WHEN id = $2 THEN 'duzenleme' ELSE 'cakisma' END
          WHERE id = ANY($3::int[]) AND ended_at IS NULL`,
        [id, edited?.id ?? null, replaces, at],
      )
    }
    await client.query('COMMIT')
    return {
      zone: { id, lo: req.lo, hi: req.hi, createdAt: ins[0]!.created_at.getTime(), breaksFrom: ins[0]!.breaks_from.getTime(), replaces },
      ended: replaces,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function endZone(id: number): Promise<void> {
  const client = await dbWrite().connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE elle_zones IN SHARE ROW EXCLUSIVE MODE')
    const at = await lockedNow(client)
    const { rowCount } = await client.query(
      `UPDATE elle_zones SET ended_at = $2, end_reason = 'kapatma'
        WHERE id = $1 AND created_at < $2 AND (ended_at IS NULL OR ended_at > $2)`,
      [id, at],
    )
    if (!rowCount) throw new ZoneWriteError(404, `#${id} artık geçerli değil (başka bir ekrandan değişmiş olabilir)`)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
