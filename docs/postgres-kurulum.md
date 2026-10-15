# Postgres kurulumu (Railway)

Railway'de açılan Postgres servisi hemen çalışır. Yapılacaklar: bağlanmak, şemayı uygulamak, yedeği açmak.

## 1. Adresler

Postgres servisi → Variables:

- `DATABASE_URL`: özel ağ adresi (`postgres.railway.internal`). Yalnız aynı projedeki servisler kullanır; servislere değişken olarak `${{Postgres.DATABASE_URL}}` verilir.
- `DATABASE_PUBLIC_URL`: dışarıdan bağlanmak için (DBeaver, kendi bilgisayarın). Biçimi `postgresql://postgres:ŞİFRE@SUNUCU:PORT/railway`.

İkisi de gizli bilgidir; repoya, sohbete ya da ekran görüntüsüne girmesin.

## 2. DBeaver bağlantısı

New Database Connection → PostgreSQL → Main sekmesi. Değerler `DATABASE_PUBLIC_URL` içinden:

| Alan | Değer |
|---|---|
| Host | `@` ile `:` arasındaki sunucu adı (`....proxy.rlwy.net`) |
| Port | sunucu adından sonraki sayı |
| Database | `railway` |
| Username | `postgres` |
| Password | `postgres:` ile `@` arasındaki şifre |

SSL sekmesi: Use SSL işaretli, SSL mode `require`. Ardından Test Connection.

## 3. Şemayı uygula

Şema PR'ı birleştikten sonra iki yoldan biri:

**DBeaver ile:** `packages/db/migrations/001_ham_veri.sql` dosyasının içeriğini bu bağlantının SQL editörüne yapıştır ve Execute SQL Script (Alt+X) ile çalıştır. Dosya tekrar çalıştırılabilir; ikinci çalıştırmadaki "already exists" uyarıları zararsızdır.

**Komutla** (Node 22 veya üstü):

```
git clone https://github.com/ariagdere/paraleltrading
cd paraleltrading
npm install
DATABASE_URL="<DATABASE_PUBLIC_URL>" PGSSL=true npm run migrate
```

Windows PowerShell'de son satır:

```
$env:DATABASE_URL="<DATABASE_PUBLIC_URL>"; $env:PGSSL="true"; npm run migrate
```

İkisini de yapmasan toplayıcı servis ilk açılışında şemayı kendisi uygular. Elle uygulanmış bir veritabanında da sorun çıkmaz; servis aynı dosyayı yeniden çalıştırıp kaydını tutar.

## 4. Kontrol

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY 1;
```

Beklenen 8 tablo: `axi_candles`, `axi_symbol_spec`, `calendar_events`, `collector_runs`, `collector_status`, `daily_bias`, `heatmap_snapshots`, `lsr_series`. Komutla uyguladıysan bir de `schema_migrations`.

## 5. Yedek

Heatmap snapshot'ları ve L/S serisi sonradan geri çekilemez (Binance L/S için yalnız son 30 günü veriyor). Postgres servisi → Backups sekmesinden günlük (Daily) yedeği aç; günlük yedekler 6 gün tutulur. Yedekler artımlıdır ve disk ile aynı fiyattan ücretlenir.

## Disk tahmini

Üç heatmap penceresi saatte bir gzip'li yazılınca veritabanı yılda kabaca 1 GB büyür. İlk gerçek çıktılarda snapshot başına 12h yaklaşık 18 KB, 24h 50 KB, 48h 46 KB tutuyor (saatte toplam 115 KB civarı); mumlar ve L/S bunun yanında küçük kalır. Railway Hobby planında bir volume 5 GB ile sınırlı; Pro'da 1 TB'a kadar büyütülebilir. Disk ücreti GB başına aylık 0,15 dolar.
