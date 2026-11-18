'use client'

import { useEffect, useState } from 'react'
import type { ManualZone } from '@/lib/chart-shared'
import type { ZoneConflict, ZoneRule, ZoneWarning } from '@/lib/zone-rules'
import { dm } from './format'
import s from './price-chart.module.css'

// Zon ekleme / düzenleme paneli (grafiğin altında): çizimde ipucu; taslak varken üst/alt fiyat, genişlik, kırılma
// takibi, mıknatıs, çakışan zonlar (pasife alınacaklar işaretli) ve uyarılar; kaydetmeden önce onay özeti.

const f2 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 })
const f0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
const round2 = (v: number) => Math.round(v * 100) / 100

// "74250", "74250,5", "74.250,5", "74,250.5" → sayı
export function parsePrice(text: string): number | null {
  let t = text.trim().replace(/\s|\$/g, '')
  if (!t) return null
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  else if (t.includes(',')) t = t.replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
  const v = Number(t)
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null
}

export type ZonePanelProps = {
  mode: 'draw' | 'adjust'
  editId: number | null
  editZone: ManualZone | null // düzenlenen zon (başka ekrandan kapandıysa null)
  first: number | null
  draft: { lo: number; hi: number } | null
  rule: ZoneRule | null
  conflicts: ZoneConflict[]
  keep: Set<number> // çakışıp kalacak (işareti kaldırılmış) zonlar
  warnings: ZoneWarning[]
  breaksFrom: string // YYYY-MM-DD (İstanbul)
  magnet: boolean
  confirm: 'save' | 'end' | null
  busy: boolean
  error: string | null
  onDraft: (lo: number, hi: number) => void
  onKeep: (id: number, keep: boolean) => void
  onBreaksFrom: (d: string) => void
  onMagnet: (on: boolean) => void
  onSave: () => void
  onEnd: () => void
  onBack: () => void
  onCancel: () => void
}

// Yazılan fiyat çıkınca ya da Enter'da işlenir (her tuşta değil: yazarken bant yerinden oynamasın). İlk Enter fiyatı
// işler, değişmemiş fiyatta Enter kaydetmeye gider.
function PriceInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(f2.format(value))
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    if (!focus) setText(f2.format(value))
  }, [value, focus])
  const commit = () => {
    const v = parsePrice(text)
    if (v === null || v === value) return false
    onCommit(v)
    return true
  }
  return (
    <label className={s.zField}>
      <span>{label}</span>
      <input
        className="num"
        inputMode="decimal"
        value={text}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setFocus(false)
          if (!commit()) setText(f2.format(value))
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && commit()) e.stopPropagation()
        }}
      />
    </label>
  )
}

export function ZonePanel(p: ZonePanelProps) {
  const d = p.draft
  const editId = p.editId
  const editFrom = p.editZone ? dm.format(p.editZone.breaksFrom) : '—'
  const title = editId !== null ? `#${editId} düzenleniyor` : 'Yeni zon'
  const ended = p.conflicts.filter((c) => !p.keep.has(c.id))
  const kept = p.conflicts.filter((c) => p.keep.has(c.id))
  const conflictText = (c: ZoneConflict) =>
    c.kind === 'kesisiyor' ? 'kesişiyor' : `arası ${f0.format(c.gap)} $ (eşik ${f0.format(p.rule?.threshold ?? 0)} $)`

  if (p.confirm) {
    return (
      <section className={s.zPanel} aria-label="Zon değişikliği onayı" aria-live="polite">
        <p className={s.zTitle}>Onay</p>
        <ul className={s.zSummary}>
          {p.confirm === 'end' && p.editZone && (
            <li>
              #{p.editZone.id} {f2.format(p.editZone.lo)}–{f2.format(p.editZone.hi)} pasife alınacak; yerine zon eklenmeyecek.
            </li>
          )}
          {p.confirm === 'save' && d && (
            <>
              <li>
                Yeni zon {f2.format(d.lo)}–{f2.format(d.hi)} eklenecek: kaydedildiği andan geçerli, kırılma takibi başlangıcı{' '}
                {editId !== null
                  ? `${editFrom} (#${editId} ile aynı)`
                  : dm.format(Date.parse(`${p.breaksFrom}T00:00:00+03:00`))}
                .
              </li>
              {editId !== null && <li>#{editId} pasife alınacak (düzenleme).</li>}
              {ended.map((c) => (
                <li key={c.id}>
                  #{c.id} {f2.format(c.lo)}–{f2.format(c.hi)} pasife alınacak ({conflictText(c)}).
                </li>
              ))}
              {kept.map((c) => (
                <li key={c.id}>
                  #{c.id} kalacak; yeni zonla {conflictText(c)}.
                </li>
              ))}
              {p.warnings.map((w) => (
                <li key={w.code} className={s.zWarn}>
                  {w.text}.
                </li>
              ))}
            </>
          )}
        </ul>
        <p className={s.zHint}>SDL değişikliği en geç 1 dakikada görür; açık pozisyonların SL/TP&apos;si değişmez.</p>
        {p.error && (
          <p className={s.zError} role="alert">
            {p.error}
          </p>
        )}
        <div className={s.zActions}>
          <button type="button" className={s.zPrimary} onClick={p.confirm === 'end' ? p.onEnd : p.onSave} disabled={p.busy}>
            {p.busy ? 'Kaydediliyor…' : 'Onayla'}
          </button>
          <button type="button" className={s.zButton} onClick={p.onBack} disabled={p.busy}>
            Geri
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className={s.zPanel} aria-label={title}>
      <div className={s.zHead}>
        <p className={s.zTitle}>{title}</p>
        <label className={s.zCheck}>
          <input type="checkbox" checked={p.magnet} onChange={(e) => p.onMagnet(e.target.checked)} />
          Mıknatıs
        </label>
      </div>
      {!d ? (
        <p className={s.zHint}>
          {p.first === null
            ? 'Grafikte basılı tutup dikey sürükle ya da üst ve alt sınıra ayrı ayrı tıkla. Esc: vazgeç.'
            : `İlk sınır ${f2.format(p.first)}; şimdi diğer sınıra tıkla.`}
        </p>
      ) : (
        <>
          <div className={s.zRow}>
            {/* yazılan kenar diğerini geçerse bant genişliği korunarak taşınır */}
            <PriceInput label="Üst" value={d.hi} onCommit={(v) => p.onDraft(v > d.lo ? d.lo : round2(v - (d.hi - d.lo)), v)} />
            <PriceInput label="Alt" value={d.lo} onCommit={(v) => p.onDraft(v, v < d.hi ? d.hi : round2(v + (d.hi - d.lo)))} />
            <p className={`num ${s.zWidth}`}>
              {f2.format(d.hi - d.lo)} $ · %{((100 * (d.hi - d.lo)) / d.lo).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}
            </p>
            {editId === null ? (
              <label className={s.zField}>
                <span>Kırılma takibi başlangıcı</span>
                <input type="date" value={p.breaksFrom} max={new Date().toISOString().slice(0, 10)} onChange={(e) => e.target.value && p.onBreaksFrom(e.target.value)} />
              </label>
            ) : (
              <p className={s.zHint}>
                Kırılma takibi başlangıcı: {editFrom} (#{editId} ile aynı).
              </p>
            )}
          </div>
          <p className={s.zHint}>Kenarları grafikte sürükleyerek ya da kutulara yazarak ayarla. Enter: kaydet, Esc: vazgeç.</p>
          {p.conflicts.length > 0 && (
            <fieldset className={s.zConflicts}>
              <legend>Çakışan zonlar: işaretliler pasife alınır</legend>
              {p.conflicts.map((c) => (
                <label key={c.id} className={s.zCheck}>
                  <input type="checkbox" checked={!p.keep.has(c.id)} onChange={(e) => p.onKeep(c.id, !e.target.checked)} />
                  <span className="num">
                    #{c.id} {f2.format(c.lo)}–{f2.format(c.hi)}
                  </span>
                  <span className={s.zMuted}>{conflictText(c)}</span>
                </label>
              ))}
            </fieldset>
          )}
          {p.warnings.length > 0 && (
            <ul className={s.zSummary}>
              {p.warnings.map((w) => (
                <li key={w.code} className={s.zWarn}>
                  {w.text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {p.error && (
        <p className={s.zError} role="alert">
          {p.error}
        </p>
      )}
      <div className={s.zActions}>
        {d && (
          <button type="button" className={s.zPrimary} onClick={p.onSave} disabled={p.busy || !p.rule}>
            Kaydet
          </button>
        )}
        {editId !== null && (
          <button type="button" className={s.zButton} onClick={p.onEnd} disabled={p.busy}>
            Pasife al
          </button>
        )}
        <button type="button" className={s.zButton} onClick={p.onCancel} disabled={p.busy}>
          Vazgeç
        </button>
      </div>
    </section>
  )
}
