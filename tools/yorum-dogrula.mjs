// Yorum dosyasının biçim denetimi; core'un kabul kuralıyla aynı (apps/core/src/sim/job.ts, parseComment).
// Kullanım: node tools/yorum-dogrula.mjs yorum/<id>.json   (bağımlılık yok)
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const file = process.argv[2]
if (!file) {
  console.error('kullanım: node tools/yorum-dogrula.mjs yorum/<id>.json')
  process.exit(2)
}
const errors = []
const id = Number(basename(file, '.json'))
if (!Number.isInteger(id) || id <= 0) errors.push('dosya adı <koşu numarası>.json olmalı')
let j
try {
  j = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`✗ geçerli JSON değil: ${e.message}`)
  process.exit(1)
}
const str = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max
const strs = (v, minItems, maxItems, max) => Array.isArray(v) && v.length >= minItems && v.length <= maxItems && v.every((x) => str(x, max))
if (j === null || typeof j !== 'object' || Array.isArray(j)) errors.push('nesne değil')
else {
  if (j.run_id !== id) errors.push(`run_id (${JSON.stringify(j.run_id)}) dosya adındaki koşu numarasıyla (${id}) aynı sayı olmalı`)
  if (!str(j.generated_at, 40) || Number.isNaN(Date.parse(j.generated_at))) errors.push('generated_at ISO 8601 zaman olmalı')
  if (!str(j.ozet, 3000)) errors.push('ozet boş olmamalı, en çok 3000 karakter')
  if (typeof j.gecerlilik !== 'string' || j.gecerlilik.length > 3000) errors.push('gecerlilik metin olmalı (önceki koşu yoksa boş metin), en çok 3000 karakter')
  if (!strs(j.bulgular, 1, 8, 800)) errors.push('bulgular 1–8 maddelik metin listesi olmalı, madde başına en çok 800 karakter')
  if (!strs(j.oneriler ?? [], 0, 5, 800)) errors.push('oneriler en çok 5 maddelik metin listesi olmalı')
  if (!['Düşük', 'Orta', 'Yüksek'].includes(j.guven)) errors.push('guven Düşük, Orta ya da Yüksek olmalı')
}
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  process.exit(1)
}
console.log(`✓ ${file} geçerli`)
