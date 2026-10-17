# Aave V3 Arbitrum Tasfiye Botu (Liquidation Bot)

Bu proje, Arbitrum One ağı üzerindeki Aave V3 protokolünde Sağlık Faktörü (Health Factor) 1.0 seviyesinin altına inen borç pozisyonlarını tespit eden ve Flaş Kredi (Flash Loan) kullanarak tasfiye işlemlerini gerçekleştiren otomatik bir sistemdir.

## Projenin Amacı

Merkeziyetsiz finans (DeFi) borçlanma protokollerinde kullanıcılar, belirli kripto paraları teminat göstererek karşılığında farklı varlıklar borç alabilirler. Piyasadaki fiyat hareketleri nedeniyle teminatın değeri düşerse veya alınan borcun değeri artarsa, borçlunun teminatı borcunu karşılayamaz duruma gelebilir. Protokolde kullanıcının Sağlık Faktörü 1.0 seviyesinin altına indiğinde bu pozisyon batık kabul edilir ve tasfiyeye açılır.

Aave protokolü, bu riskli pozisyonları kapatan kullanıcılara indirimli teminat alma hakkı (tasfiye primi) tanır. Bu botun temel amacı, riskli pozisyonları gecikme yaşamadan tespit etmek, Flaş Kredi mekanizması sayesinde kendi sermayesini riske atmadan borcu ödemek, indirimli teminatı devralıp piyasada satmak ve oluşan kârı doğrudan cüzdana aktarmaktır.

## Sistemin İşleyiş Mantığı

Sistem iki ana bileşenin uyum içinde çalışmasıyla işler:

### 1. İzleme ve Karar Katmanı (TypeScript)

Blokzincir üzerindeki verileri sürekli takip eden ve tetikleme kararını veren gözlemci motorudur:

- Kalıcı Borçlu Radarı: Sistem daha önce borç almış kullanıcıları yerel veri tabanında saklar. Ayrıca ağdaki yeni borçlanma işlemlerini canlı olarak dinleyerek listeye otomatik olarak ekler.
- Çift Kademeli Tarama:
  - Kritik Radar: Sağlık Faktörü 1.12 seviyesinin altına inmiş riskli kullanıcılar her 2 saniyede bir kontrol edilir. Böylece pozisyon 1.0 seviyesinin altına düştüğü an vakit kaybetmeden işlem başlatılır.
  - Genel Radar: Diğer tüm kayıtlı kullanıcılar düzenli aralıklarla kontrol edilir ve sağlık durumu bozulanlar anında kritik listeye taşınır.
- Toplu Sorgulama (Multicall3): Yüzlerce cüzdanın durumu tek tek sorgulanmak yerine tek bir istek paketi içinde blokzincirden okunur. Bu yaklaşım hem sorgu limitlerine takılmayı önler hem de hızı artırır.
- Otomatik Kârlılık ve Çift Seçimi: Aave Fiyat Kâhini (Oracle) ve veri sağlayıcısı üzerinden borçlunun tüm borç ve teminatları değerlendirilir. En yüksek getiriyi sağlayacak borç-teminat eşleşmesi dinamik olarak belirlenir.
- Dinamik Kapatma Oranı: Aave kurallarına uygun olarak Sağlık Faktörü 0.95 altında ise borcun yüzde 100'ü, 0.95 ile 1.0 arasında ise yüzde 50'si kapatılacak şekilde tutar belirlenir.
- Sıfır Riskli Ön Simülasyon: Gerçek işlem ağa iletilmeden önce simülasyon yapılır. Yeterli kâr bırakmayan veya başarısız olacak işlemler zincire gönderilmez; böylece gereksiz işlem ücreti harcanmaz.

### 2. Akıllı Sözleşme Katmanı (Solidity)

Tasfiye adımını blokzincir üzerinde tek bir işlem içinde (atomik olarak) tamamlayan yürütme merkezidir:

- Flaş Kredi (Flash Loan): İşlem için cüzdanda ön sermaye bulunması gerekmez. Sözleşme, Aave havuzundan gereken tutarda borcu sıfır teminatla anlık olarak ödünç alır.
- Tasfiye Çağrısı: Alınan bu borçla riskli kullanıcının borcu kapatılır ve kullanıcının indirimli teminatı sözleşmeye aktarılır.
- Otomatik Satış (Uniswap V3): Elde edilen teminat, Uniswap V3 borsası üzerinden hemen borç varlığına dönüştürülür.
- Kredi İadesi ve Güvenlik Kontrolü: Flaş kredinin anapara ve faiz tutarı Aave protokolüne geri ödenir. Eğer yapılan satış borcu ve masrafları karşılamaya yetmiyorsa işlem baştan iptal edilir.
- Anında Kâr Aktarımı: Masraflar ödendikten sonra kalan net kâr sözleşmede bekletilmez; doğrudan sözleşme sahibinin cüzdanına gönderilir.

## Temel Özellikler

- Sıfır Sermaye Gereksinimi: Flaş Kredi kullanımı sayesinde kullanıcı bakiyesine ihtiyaç duyulmadan büyük hacimli tasfiyeler gerçekleştirilebilir.
- Sıfır Zarar Koruması: İşlem öncesi simülasyon ve sözleşme içi kontroller sayesinde kâr getirmeyecek hiçbir işlem ağda onaylanmaz ve zarar oluşmaz.
- Çoklu Varlık Uyumluluğu:
  - Borç Varlıkları: Native USDC, Bridged USDC.e, USDT
  - Teminat Varlıkları: WETH, WBTC, ARB
- Hızlı Veri İletişimi: Multicall3 altyapısı sayesinde minimum gecikme ve düşük ağ masrafı ile çalışır.
- Yüksek Güvenlik Standardı: Token transferlerinde ve harcama izinlerinde OpenZeppelin SafeERC20 standartları uygulanır.

## Proje Mimarisi

- bot/: Blokzinciri dinleyen, kullanıcıları takip eden, analiz yapan ve sözleşmeyi tetikleyen TypeScript tabanlı izleme katmanı.
  - bot/src/index.ts: Ana radar döngüleri, kullanıcı takibi, fiyat hesaplamaları ve işlem simülasyonu.
  - bot/data/monitored_users.json: Takip edilen aktif borçlu adreslerinin kalıcı kayıt dosyası.
- contracts/: Arbitrum ağı üzerinde çalışan Foundry ve Solidity tabanlı akıllı sözleşme katmanı.
  - contracts/src/LiquidationBot.sol: Flaş kredi, tasfiye, Uniswap takası ve kâr aktarımını gerçekleştiren ana sözleşme.
  - contracts/script/Deploy.s.sol: Sözleşmenin Arbitrum ağına dağıtımını sağlayan betik.
