# Aave V3 Arbitrum Liquidation Bot

Bu proje, Arbitrum ağı üzerindeki Aave V3 protokolünde Sağlık Faktörü (Health Factor) 1.0'ın altına düşen pozisyonları tespit eden ve tasfiye (liquidation) işlemlerini otomatize eden profesyonel bir algoritmik ticaret botudur.

## Mimari Yapı

Proje iki ana bileşenden oluşmaktadır:

1. **İzleme Motoru (TypeScript / Viem):** 
   - `bot/` klasörü altında çalışır. 
   - Aave havuzundaki işlemleri dinleyerek (watchEvent) aktif borçluları tespit eder ve kendi "Radar" veritabanına ekler.
   - Her 15 saniyede bir radardaki kullanıcıların Sağlık Faktörlerini asenkron olarak sorgular.
   - Tasfiye koşulu sağlandığında, işlemi blockchain'e göndermeden önce anlık simülasyon (simulateContract) yapar. Kâr elde edilemeyecekse (yetersiz likidite, yüksek gas vb.) işlemi iptal ederek gas masraflarını sıfıra indirir.

2. **Akıllı Sözleşme (Solidity / Foundry):**
   - `contracts/` klasörü altında geliştirilmiş ve Arbitrum ana ağına yüklenmiştir.
   - Tetiklendiği an Aave'den "Flaş Kredi" (Flash Loan) çekerek batık pozisyonun borcunun %50'sini öder.
   - Elde edilen teminatı (Örn: WETH) Uniswap V3 üzerinden satıp Flaş Kredi borcunu kapatır.
   - Arta kalan net kârı hiçbir havuzda bekletmeden **anında** sözleşme sahibinin (Owner) MetaMask cüzdanına transfer eder.

## Temel Özellikler

- **Dinamik Borç Hesaplaması:** Sabit bir rakam yerine, kullanıcının o anki gerçek borcunu zincir üzerinden okuyup Aave kuralları gereği maksimum kapatma faktörünü (%50) otomatik hesaplar.
- **Aktif Radar Modu:** Sadece olay bazlı değil, döngüsel (polling) tarama yaparak piyasadaki ani fiyat çöküşlerini saniyesinde yakalar.
- **Maksimum Güvenlik:** Kâr anında cüzdana aktarılır, `.env` dosyaları gitignore ile korunur ve tüm zararlı işlemler simülasyon filtresine takılır.

## Kullanım

Sunucu ortamında (Örn: Ubuntu VPS) 7/24 kesintisiz çalışması için PM2 yöneticisi kullanılması tavsiye edilir:
\`\`\`bash
cd bot
npm install
pm2 start npm --name "liquidation-bot" -- run start
\`\`\`
