import type { NextConfig } from 'next'

// @pt/db TypeScript kaynağı olarak paylaşılıyor (derlenmiş paket yok); pg ve MetaApi SDK'sı sunucuda paketlenmeden
// kullanılır (SDK'nin paket kökündeki "import" koşulu tarayıcı derlemesine gidiyor).
const nextConfig: NextConfig = {
  transpilePackages: ['@pt/db'],
  serverExternalPackages: ['pg', 'metaapi.cloud-sdk'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
