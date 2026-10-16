import type { NextRequest } from 'next/server'
import { ensureLive, getLive, liveStatus, type Quote } from '@/lib/live'

// Canlı Axi fiyatı (Server-Sent Events). Oturum proxy'de. Olaylar:
//   hello  bağlanınca bir kez: akışın durumu ve son quote
//   quote  {bid, ask, t}; istemci başına en çok 250 ms'de bir (arada gelenlerin sonuncusu)
//   status akış hazır değilken 5 sn'de bir (kapalı, bağlanıyor, hata)
// Railway ve ara vekiller boştaki bağlantıyı kesmesin diye 15 sn'de bir yorum satırı gider.
export async function GET(req: NextRequest) {
  void ensureLive()
  const live = getLive()
  const enc = new TextEncoder()
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const write = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(enc.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('hello', { status: liveStatus(), quote: live.last })

      let pending: Quote | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      const flush = () => {
        timer = null
        if (pending) send('quote', pending)
        pending = null
      }
      const onQuote = (q: Quote) => {
        pending = q
        if (!timer) timer = setTimeout(flush, 250)
      }
      live.emitter.on('quote', onQuote)
      const statusTimer = setInterval(() => {
        const st = liveStatus()
        if (st.state === 'ready' || st.state === 'off') return // kapalıyken hello yeterli (ayar ancak yeniden başlatmayla değişir)
        void ensureLive() // hatadan 30 sn sonra yeniden dener
        send('status', st)
      }, 5000)
      const pingTimer = setInterval(() => write(': ping\n\n'), 15_000)

      cleanup = () => {
        if (closed) return
        closed = true
        live.emitter.off('quote', onQuote)
        if (timer) clearTimeout(timer)
        clearInterval(statusTimer)
        clearInterval(pingTimer)
        try {
          controller.close()
        } catch {
          // zaten kapalı
        }
      }
      req.signal.addEventListener('abort', () => cleanup())
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: sıkıştırma ve ara vekiller akışı tamponlamasın
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
