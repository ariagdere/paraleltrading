import type { IChartApi, ISeriesApi } from 'lightweight-charts'

// Elle zon çizme ve düzenleme: grafik üzerindeki fare ve dokunma hareketleri (Ari, 18 Kasım).
// - Çizim ("Zon ekle" açıkken): grafikte basılı tutup dikey sürükle ya da iki kenara ayrı ayrı tıkla / dokun.
// - İnce ayar: taslağın üst ve alt kenarı (çizginin herhangi bir yeri) tutup sürüklenir; başka yerde grafik eskisi gibi
//   kayar ve yakınlaşır.
// - Düzenleme: bir zonun numarasına (#7) tıklayınca o zon seçilir.
// - Mıknatıs: kenar, imlecin altındaki mumun tepe, dip, açılış ya da kapanışına 12 px'ten yakınsa ona yapışır; değilse
//   tam dolara yuvarlanır.
// lightweight-charts fare ve dokunma olaylarını kendi iç elemanlarında dinliyor; çizim ve kenar sürükleme grafik
// kutusunda CAPTURE aşamasında durdurulur: grafik kaymaz, sayfa kaydırılmaz. Eski sistemin /live grafiğinde aynısı
// (hakari-dashboard lib/zoneEditor.ts) ve SL/TP sürüklemesi (lib/chartLevelInteractions.ts) aynı yoldan.

export type EditMode = 'off' | 'draw' | 'adjust'
export type EditorView = {
  mode: EditMode
  first: number | null // çizimde tıklamayla seçilen ilk kenar
  draft: { lo: number; hi: number } | null
  magnet: boolean
}
export type EditorBar = { o: number; h: number; l: number; c: number }

export interface ZoneEditorDeps {
  container: HTMLElement
  getChart: () => IChartApi | null
  getSeries: () => ISeriesApi<'Candlestick'> | null
  getView: () => EditorView
  barAt: (x: number) => EditorBar | null
  labelAt: (x: number, y: number) => number | null
  onFirst: (price: number) => void
  onDraft: (lo: number, hi: number, final: boolean) => void
  onSelect: (id: number) => void
}

const HIT_MOUSE_PX = 7
const HIT_TOUCH_PX = 20 // parmak için geniş tutma alanı
const SLOP_PX = 5
const MAGNET_PX = 12
const EMIT_MS = 30

type Gesture = {
  kind: 'draw' | 'edge'
  pointerId: number
  startX: number
  startY: number
  start: number // çizimde basılan fiyat; kenarda sürüklenmeyen kenar
  cur: number | null
  moved: boolean
  lastEmit: number
}

export function attachZoneEditor(deps: ZoneEditorDeps) {
  const { container } = deps
  let g: Gesture | null = null
  let click: { pointerId: number; x: number; y: number; id: number } | null = null
  let frozen: boolean | null = null

  const local = (e: { clientX: number; clientY: number }) => {
    const r = container.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const pane = () => {
    const ch = deps.getChart()
    if (!ch) return null
    return { w: ch.timeScale().width(), h: container.clientHeight - ch.timeScale().height() }
  }
  const priceAt = (x: number, y: number): number | null => {
    const se = deps.getSeries()
    const p = se?.coordinateToPrice(y)
    if (!se || p == null || !Number.isFinite(p) || p <= 0) return null
    if (deps.getView().magnet) {
      const b = deps.barAt(x)
      if (b) {
        let best: { v: number; d: number } | null = null
        for (const v of [b.h, b.l, b.o, b.c]) {
          const py = se.priceToCoordinate(v)
          if (py == null) continue
          const d = Math.abs(py - y)
          if (d <= MAGNET_PX && (!best || d < best.d)) best = { v, d }
        }
        if (best) return best.v
      }
    }
    return Math.round(p)
  }
  // Basılan yere en yakın taslak kenarı (tolerans içinde).
  const hitEdge = (y: number, touch: boolean): 'lo' | 'hi' | null => {
    const v = deps.getView()
    const se = deps.getSeries()
    if (v.mode !== 'adjust' || !v.draft || !se) return null
    const tol = touch ? HIT_TOUCH_PX : HIT_MOUSE_PX
    let best: { k: 'lo' | 'hi'; d: number } | null = null
    for (const k of ['hi', 'lo'] as const) {
      const ly = se.priceToCoordinate(v.draft[k])
      if (ly == null) continue
      const d = Math.abs(ly - y)
      if (d <= tol && (!best || d < best.d)) best = { k, d }
    }
    return best?.k ?? null
  }
  // Sürüklerken fiyat ekseni sabit: otomatik ölçek kenarı imlecin altından kaydırmasın.
  const freeze = () => {
    const ps = deps.getChart()?.priceScale('right')
    if (!ps) return
    frozen = ps.options().autoScale
    ps.applyOptions({ autoScale: false })
  }
  const unfreeze = () => {
    const ps = deps.getChart()?.priceScale('right')
    if (ps && frozen != null) ps.applyOptions({ autoScale: frozen })
    frozen = null
  }
  const emit = (final: boolean) => {
    if (!g || g.cur === null) return
    const a = Math.min(g.start, g.cur)
    const b = Math.max(g.start, g.cur)
    if (b > a) deps.onDraft(a, b, final)
  }

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const { x, y } = local(e)
    const box = pane()
    if (!box || x < 0 || x > box.w || y < 0 || y > box.h) return
    const v = deps.getView()
    const edge = hitEdge(y, e.pointerType !== 'mouse')
    if (edge || v.mode === 'draw') {
      const start = edge ? v.draft![edge === 'hi' ? 'lo' : 'hi'] : priceAt(x, y)
      if (start === null) return
      g = { kind: edge ? 'edge' : 'draw', pointerId: e.pointerId, startX: x, startY: y, start, cur: null, moved: false, lastEmit: 0 }
      e.preventDefault() // fare: uyumluluk mouse olayları (grafiğin kayması) üretilmez
      e.stopPropagation()
      try {
        container.setPointerCapture(e.pointerId)
      } catch {
        // desteklenmiyorsa hareketler yine kutuya gelir
      }
      freeze()
      container.classList.add('zone-dragging')
      return
    }
    const id = deps.labelAt(x, y)
    click = id === null ? null : { pointerId: e.pointerId, x, y, id }
  }

  const onMove = (e: PointerEvent) => {
    if (!g || g.pointerId !== e.pointerId) {
      if (e.pointerType === 'mouse') {
        const { x, y } = local(e)
        container.classList.toggle('zone-edge-hover', hitEdge(y, false) !== null)
        container.classList.toggle('zone-label-hover', deps.getView().mode !== 'draw' && deps.labelAt(x, y) !== null)
      }
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const box = pane()
    if (!box) return
    const { x, y: raw } = local(e)
    const y = Math.max(0, Math.min(box.h, raw))
    if (!g.moved && Math.abs(y - g.startY) < SLOP_PX) return
    g.moved = true
    const p = priceAt(x, y)
    if (p === null || p === g.cur) return
    g.cur = p
    const now = performance.now()
    if (now - g.lastEmit >= EMIT_MS) {
      g.lastEmit = now
      emit(false)
    }
  }

  const finish = (e: PointerEvent): Gesture | null => {
    if (!g || g.pointerId !== e.pointerId) return null
    const done = g
    try {
      container.releasePointerCapture(e.pointerId)
    } catch {
      // zaten bırakılmış
    }
    container.classList.remove('zone-dragging')
    unfreeze()
    return done
  }

  const onUp = (e: PointerEvent) => {
    const done = finish(e)
    if (done) {
      e.preventDefault()
      e.stopPropagation()
      if (done.moved) emit(true)
      else if (done.kind === 'draw') {
        // tıklama: ilk kenar ya da ikinci kenar
        const v = deps.getView()
        if (v.first === null) deps.onFirst(done.start)
        else if (done.start !== v.first) deps.onDraft(Math.min(v.first, done.start), Math.max(v.first, done.start), true)
      }
      g = null
      return
    }
    const c = click
    click = null
    if (!c || c.pointerId !== e.pointerId) return
    const { x, y } = local(e)
    if (Math.hypot(x - c.x, y - c.y) <= SLOP_PX) deps.onSelect(c.id)
  }

  const onCancel = (e: PointerEvent) => {
    if (finish(e)) g = null
    click = null
  }

  // Çizerken ve kenar sürüklenirken dokunma / fare olayları grafiğe ulaşmasın; dokunmada sayfa da kaymasın.
  const onTouch = (e: TouchEvent) => {
    if (g) {
      if (e.cancelable) e.preventDefault()
      e.stopPropagation()
    }
  }
  const onMouse = (e: MouseEvent) => {
    if (g) e.stopPropagation()
  }
  const onLeave = () => container.classList.remove('zone-edge-hover', 'zone-label-hover')

  const opts = { capture: true }
  const touchOpts: AddEventListenerOptions = { capture: true, passive: false }
  container.addEventListener('pointerdown', onDown, opts)
  container.addEventListener('pointermove', onMove, opts)
  container.addEventListener('pointerup', onUp, opts)
  container.addEventListener('pointercancel', onCancel, opts)
  container.addEventListener('touchstart', onTouch, touchOpts)
  container.addEventListener('touchmove', onTouch, touchOpts)
  container.addEventListener('touchend', onTouch, touchOpts)
  container.addEventListener('mousedown', onMouse, opts)
  container.addEventListener('mousemove', onMouse, opts)
  container.addEventListener('mouseup', onMouse, opts)
  container.addEventListener('pointerleave', onLeave)

  return {
    detach: () => {
      container.removeEventListener('pointerdown', onDown, opts)
      container.removeEventListener('pointermove', onMove, opts)
      container.removeEventListener('pointerup', onUp, opts)
      container.removeEventListener('pointercancel', onCancel, opts)
      container.removeEventListener('touchstart', onTouch, touchOpts)
      container.removeEventListener('touchmove', onTouch, touchOpts)
      container.removeEventListener('touchend', onTouch, touchOpts)
      container.removeEventListener('mousedown', onMouse, opts)
      container.removeEventListener('mousemove', onMouse, opts)
      container.removeEventListener('mouseup', onMouse, opts)
      container.removeEventListener('pointerleave', onLeave)
      unfreeze()
    },
  }
}
