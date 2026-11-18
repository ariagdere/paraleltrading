'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import { SetupChart } from '@/components/sdl/SetupChart'
import s from './sdl.module.css'

// Tıklanınca altında kurulumun grafiği açılan tablo satırı (hücreler sunucuda çizilir, children). İlk hücredeki
// RowToggle düğmesi klavye ve ekran okuyucu için; satırın herhangi bir yerine tıklamak da açar (metin seçerken değil).

const Ctx = createContext<{ open: boolean; toggle: () => void } | null>(null)

export function ChartRow({ query, cols, stamp, children }: { query: string; cols: number; stamp?: string | number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((o) => !o)
  return (
    <Ctx.Provider value={{ open, toggle }}>
      <tr
        className={s.clickRow}
        data-open={open ? 'true' : 'false'}
        onClick={(e) => {
          if ((e.target as Element).closest('button, a, input, select, textarea')) return
          if (window.getSelection()?.toString()) return
          toggle()
        }}
      >
        {children}
      </tr>
      {open && (
        <tr className={s.chartRow}>
          <td colSpan={cols}>
            <SetupChart query={query} stamp={stamp} />
          </td>
        </tr>
      )}
    </Ctx.Provider>
  )
}

export function RowToggle({ label, children }: { label: string; children: ReactNode }) {
  const c = useContext(Ctx)
  const open = c?.open ?? false
  return (
    <button type="button" className={s.rowToggle} aria-expanded={open} aria-label={`${label}: grafiği ${open ? 'kapat' : 'aç'}`} onClick={() => c?.toggle()}>
      <span className={s.chev} aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
      {children}
    </button>
  )
}
