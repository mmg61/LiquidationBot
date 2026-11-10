# Aave V3 Arbitrum Tasfiye Botu (Liquidation Bot)

Bu proje, Arbitrum One ağı üzerindeki Aave V3 protokolünde Sağlık Faktörü (Health Factor) 1.0 seviyesinin altına inen borç pozisyonlarını tespit eden ve Flaş Kredi (Flash Loan) kullanarak tasfiye işlemlerini gerçekleştiren otomatik bir sistemdir.

## Projenin Amacı

Merkeziyetsiz finans (DeFi) borçlanma protokollerinde kullanıcılar, belirli kripto paraları teminat göstererek karşılığında farklı varlıklar borç alabilirler. Piyasadaki fiyat hareketleri nedeniyle teminatın değeri düşerse veya alınan borcun değeri artarsa, borçlunun teminatı borcunu karşılayamaz duruma gelebilir. Protokolde kullanıcının Sağlık Faktörü 1.0 seviyesinin altına indiğinde bu pozisyon batık kabul edilir ve tasfiyeye açılır.

Aave protokolü, bu riskli pozisyonları kapatan kullanıcılara indirimli teminat alma hakkı (tasfiye primi) tanır. Bu botun temel amacı, riskli pozisyonları gecikme yaşamadan tespit etmek, Flaş Kredi mekanizması sayesinde kendi sermayesini riske atmadan borcu ödemek, indirimli teminatı devralıp piyasada satmak ve oluşan kârı doğrudan cüzdana aktarmaktır.

## Sistemin İşleyiş Mantığı

Sistem üç ana bileşenin uyum içinde çalışmasıyla işler:

### 1. İzleme ve Karar Katmanı (TypeScript)

Blokzincir üzerindeki verileri sürekli takip eden ve tetikleme kararını veren gözlemci motorudur:

- Kalıcı Borçlu Radarı (`onBehalfOf` Takibi): Sistem daha önce borç almış kullanıcıları yerel veri tabanında saklar. Ağdaki yeni borçlanma işlemlerinde aracı kontratlar yerine borcun gerçek sahibi olan `onBehalfOf` adresini dinleyerek kaldıraçlı pozisyonları da otomatik olarak listeye ekler.
- Dinamik Rezerv ve Bonus Keşfi (`getAllReservesTokens`): Aave V3 Arbitrum üzerindeki tüm aktif rezerv varlıklarını, ondalık basamaklarını ve varlığa özel gerçek tasfiye bonus oranlarını protokol veri sağlayıcısından dinamik olarak çeker.
- Üç Kademeli Keskin Nişancı Taraması:
  - Ultra-Kritik Radar: Sağlık Faktörü 1.045 seviyesinin altına inmiş (tasfiyeye çok yakın) kullanıcılar çoklu RPC havuzu üzerinden her 250 milisaniyede bir (Arbitrum blok hızında) kontrol edilir.
  - Kritik Radar: Sağlık Faktörü 1.045 ile 1.12 arasında olan riskli kullanıcılar her 2.5 saniyede bir kontrol edilir.
  - Genel Radar: Diğer tüm kayıtlı kullanıcılar düzenli aralıklarla kontrol edilir ve sağlık durumu bozulanlar anında üst kademelere taşınır.
- Toplu Sorgulama (Multicall3): Yüzlerce cüzdanın durumu tek tek sorgulanmak yerine tek bir istek paketi içinde blokzincirden okunur. Bu yaklaşım hem sorgu limitlerine takılmayı önler hem de hızı artırır.
- Otomatik Kârlılık, Çoklu Çift ve Kısmi Tasfiye Seçimi: Aave Fiyat Kâhini (Oracle) ve veri sağlayıcısı üzerinden borçlunun tüm borç ve teminatları değerlendirilir. En yüksek getiriyi sağlayacak aday borç-teminat eşleşmeleri ve kısmi tasfiye oranları dinamik olarak belirlenir.
- Dinamik Kapatma Oranı: Aave kurallarına uygun olarak Sağlık Faktörü 0.95 altında ise borcun yüzde 100'ü, 0.95 ile 1.0 arasında ise yüzde 50'si kapatılacak şekilde tutar belirlenir.
- Sıfır Riskli Ön Simülasyon: Gerçek işlem ağa iletilmeden önce simülasyon yapılır. Yeterli kâr bırakmayan veya başarısız olacak işlemler zincire gönderilmez; böylece gereksiz işlem ücreti harcanmaz.

### 2. Akıllı Sözleşme Katmanı (Solidity)

Tasfiye adımını blokzincir üzerinde tek bir işlem içinde (atomik olarak) tamamlayan yürütme merkezidir:

- Flaş Kredi (Flash Loan): İşlem için cüzdanda ön sermaye bulunması gerekmez. Sözleşme, Aave havuzundan gereken tutarda borcu sıfır teminatla anlık olarak ödünç alır.
- Tasfiye Çağrısı: Alınan bu borçla riskli kullanıcının borcu kapatılır ve kullanıcının indirimli teminatı sözleşmeye aktarılır.
- Otomatik Satış (Uniswap V3): Elde edilen teminat, Uniswap V3 borsası üzerinden hemen borç varlığına dönüştürülür.
- Kredi İadesi ve Güvenlik Kontrolü: Flaş kredinin anapara ve faiz tutarı Aave protokolüne geri ödenir. Eğer yapılan satış borcu ve masrafları karşılamaya yetmiyorsa işlem baştan iptal edilir.
- Anında Kâr Aktarımı: Masraflar ödendikten sonra kalan net kâr sözleşmede bekletilmez; doğrudan sözleşme sahibinin cüzdanına gönderilir.

### 3. Web Tabanlı İzleme ve Yönetim Paneli

Botun durumunu ve piyasa hareketlerini tarayıcı üzerinden grafiksel olarak takip etmeyi sağlayan yerel web arayüzüdür:

- Gerçek Zamanlı Sistem Durumu: Bot cüzdan bakiyesi, sözleşme adresi, ağ gecikmesi ve blok verilerini anlık olarak gösterir.
- Canlı Borçlu Listesi: İzlenen borçluların Sağlık Faktörü, toplam borç ve teminat dağılımlarını risk durumuna göre listeler.
- Canlı Olay Akışı: Sistemin arka planda gerçekleştirdiği taramaları, simülasyon sonuçlarını ve tespit edilen tasfiye fırsatlarını arayüze yansıtır.
- Manuel Sorgulama ve Ekleme: Belirli bir cüzdan adresinin anlık borç durumunu tek tıkla sorgulama ve radara ekleme olanağı verir.

## Temel Özellikler

- Sıfır Sermaye Gereksinimi: Flaş Kredi kullanımı sayesinde kullanıcı bakiyesine ihtiyaç duyulmadan büyük hacimli tasfiyeler gerçekleştirilebilir.
- Sıfır Zarar Koruması: İşlem öncesi simülasyon ve sözleşme içi kontroller sayesinde kâr getirmeyecek hiçbir işlem ağda onaylanmaz ve zarar oluşmaz.
- Geniş Çoklu Varlık Uyumluluğu (14 Ana Aave Rezervi):
  - Hem Borç Hem Teminat Olarak Desteklenen Varlıklar: Native USDC, Bridged USDC.e, USDT, DAI, WETH, WBTC, wstETH, weETH, rETH, ARB, LINK, AAVE, FRAX, LUSD
- Görsel İzleme ve Kontrol: Web arayüzü üzerinden sistemin çalışmasını, son 7 günlük tasfiye analizini ve risk altındaki cüzdanları canlı izleme.
- Hızlı Veri İletişimi ve Doğrudan Sequencer Yayını: Multicall3 altyapısı, önbellekli Nonce/Gas yönetimi, paralel simülasyon ve doğrudan Arbitrum Resmi Sequencer yayını sayesinde minimum gecikme ile çalışır.

## Proje Mimarisi

- baslat-panel.bat: Yerel yönetim panelini (`http://127.0.0.1:3000`) arka planda tek tıkla başlatan betik.
- bot/: Blokzinciri dinleyen, kullanıcıları takip eden, analiz yapan, web panelini sunan ve sözleşmeyi tetikleyen TypeScript tabanlı katman.
  - bot/src/index.ts: Ana radar döngüleri, kullanıcı takibi, fiyat hesaplamaları ve işlem simülasyonu.
  - bot/src/dashboard.ts: Web takip paneli için yerel veri sunucusu ve API servisi.
  - bot/src/dashboard.html: Tarayıcı üzerinden çalışan canlı izleme ve kontrol arayüzü.
  - bot/data/monitored_users.json: Takip edilen aktif borçlu adreslerinin kalıcı kayıt dosyası.
- contracts/: Arbitrum ağı üzerinde çalışan Foundry ve Solidity tabanlı akıllı sözleşme katmanı.
  - contracts/src/LiquidationBot.sol: Flaş kredi, tasfiye, Uniswap takası ve kâr aktarımını gerçekleştiren ana sözleşme.
  - contracts/script/Deploy.s.sol: Sözleşmenin Arbitrum ağına dağıtımını sağlayan betik.
