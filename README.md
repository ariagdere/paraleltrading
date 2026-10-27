# sim-data

Kombinasyon simülasyonunun veri dalı (kod `main`'de, bu dal yalnız veri). `main`'e birleşmez.

- `runs/<id>.json`: core'un her koşu sonucu (`apps/core/src/sim`). Her ayın 1'inde 04:00'te (İstanbul) ve Hakari 2'nin Simülasyon sayfasındaki "Şimdi çalıştır"la. Core yazar (Railway'deki `SIM_GITHUB_TOKEN` ile).
- `yorum/<id>.json`: Claude rutininin ("Hakari Simülasyon Yorumu", her gün 09:37) o koşu için analizi ve yorumu. Rutin yazar; core dakikada bir okuyup sayfaya taşır.
- `ROUTINE.md`: rutinin talimatları. `tools/yorum-dogrula.mjs`: yorum dosyasının biçim denetimi (core'un kabul kuralıyla aynı).
