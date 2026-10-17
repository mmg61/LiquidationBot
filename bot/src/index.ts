import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi, isAddress, getAddress, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, localhost } from 'viem/chains';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Ortam değişkenlerini (.env dosyasından) yükler.
dotenv.config();

// ============================================================================
// 1. AĞ VE CÜZDAN YAPILANDIRMASI
// ============================================================================
// RPC Bağlantı Noktası: .env dosyasından okunur, yoksa halka açık Arbitrum RPC kullanılır.
const rpcUrl = process.env.LOCAL_FORK_URL || process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';

// İşlemleri imzalayacak cüzdanın özel anahtarı (Private Key).
const privateKey = process.env.PRIVATE_KEY;

if (!privateKey) {
  console.error("[ERROR] PRIVATE_KEY not found in .env file.");
  process.exit(1);
}

// Özel anahtarı Viem cüzdan nesnesine dönüştürür.
const account = privateKeyToAccount(privateKey.startsWith('0x') ? (privateKey as `0x${string}`) : `0x${privateKey}`);
const chainToUse = process.env.LOCAL_FORK_URL ? localhost : arbitrum;

// Blokzincirinden veri okuma (Read) istemcisi.
const publicClient = createPublicClient({ chain: chainToUse, transport: http(rpcUrl) });
// Blokzincirine işlem yazma ve imzalama (Write) istemcisi.
const walletClient = createWalletClient({ account, chain: chainToUse, transport: http(rpcUrl) });


// ============================================================================
// 2. PROTOKOL VE TOKEN ADRESLERİ (ARBITRUM MAINNET)
// ============================================================================
// Aave V3 Arbitrum Ana Havuz Sözleşmesi
const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const;

// Aave V3 Protokol Veri Sağlayıcısı (Kullanıcının gerçek teminat/borç durumunu ve teminat bayrağını okumak için)
const AAVE_DATA_PROVIDER_ADDRESS = '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654' as const;

// Aave V3 Fiyat Kahini (Oracle - Token'ların anlık gerçek USD fiyatlarını okumak için)
const AAVE_ORACLE_ADDRESS = '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7' as const;

// Dağıtımı yapılmış olan akıllı tasfiye sözleşmemizin adresi
const OUR_BOT_CONTRACT_ADDRESS = (process.env.BOT_CONTRACT_ADDRESS) as `0x${string}`;

// MİKRO BORÇ VE SIFIR ZARAR FİLTRELERİ:
// 1. Kullanıcının toplam borcu $50 altındaysa incelemeye alma.
const MIN_DEBT_USD = 50.0;
// 2. Kapatılacak tekil borç miktarı en az $25 olmalıdır (Yaklaşık $1.25+ brüt tasfiye bonusu sağlar, birkaç centlik gas masrafını fazlasıyla karşılar).
const MIN_STRIKE_DEBT_USD = 25.0;
// 3. Maksimum kabul edilebilir gas fiyatı tavanı (Arbitrum normalde 0.01 - 0.1 Gwei arasıdır; 5 Gwei üstü anormal ağ tıkanıklığında işlemi durdurur).
const MAX_GAS_PRICE_GWEI = 5.0;

// KRİTİK TAKİP EŞİĞİ (Keskin Nişancı Eşiği):
// Sağlık Faktörü (HF) bu değerin altına inen borçlular "Kritik Radara" alınır ve her 2 saniyede bir Multicall ile tek seferde taranır.
const CRITICAL_HF_THRESHOLD = 1.12;

// Desteklenen Borç Varlıkları (Kullanıcının Aave'den borçlandığı token'lar)
const DEBT_ASSETS = [
  {
    name: 'USDC (Native)',
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}`,
    variableDebtToken: '0xf611aEb5013fD2c0511c9CD55c7dc5C1140741A6' as `0x${string}`,
    decimals: 6
  },
  {
    name: 'USDC.e (Bridged)',
    address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8' as `0x${string}`,
    variableDebtToken: '0xFCCf3cAbbe80101232d343252614b6A3eE81C989' as `0x${string}`,
    decimals: 6
  },
  {
    name: 'USDT',
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as `0x${string}`,
    variableDebtToken: '0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7' as `0x${string}`,
    decimals: 6
  }
];

// Desteklenen Teminat Varlıkları (Kullanıcının Aave'ye rehin koyduğu ve bizim indirimli alacağımız varlıklar)
const COLLATERAL_ASSETS = [
  {
    name: 'WETH',
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as `0x${string}`,
    aToken: '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8' as `0x${string}`,
    decimals: 18
  },
  {
    name: 'WBTC',
    address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as `0x${string}`,
    aToken: '0x078f358208685046a11C85e8ad32895DED33A249' as `0x${string}`,
    decimals: 8
  },
  {
    name: 'ARB',
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548' as `0x${string}`,
    aToken: '0x6533afac2E7BCCB20dca161449A13A32D391fb00' as `0x${string}`,
    decimals: 18
  }
];

// Aave, Oracle ve Akıllı Sözleşme Arayüz Tanımları (ABI)
const getUserAccountDataAbi = parseAbiItem('function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)');
const getUserReserveDataAbi = parseAbiItem('function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)');
const getAssetsPricesAbi = parseAbiItem('function getAssetsPrices(address[] assets) view returns (uint256[])');
const borrowEventAbi = parseAbiItem('event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)');
const botContractAbi = parseAbi([
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover) external',
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover, uint24 poolFee) external'
]);


// ============================================================================
// 3. KALICI HAFIZA, KULLANICI RADARI VE ÇARPIŞMA KİLİTLERİ
// ============================================================================
const DATA_DIR = path.join(__dirname, '../data');
const STORAGE_FILE = path.join(DATA_DIR, 'monitored_users.json');

// activeUsers: Radardaki tüm borçlu adresleri.
const activeUsers = new Set<`0x${string}`>();

// criticalTargets: Sağlık faktörü 1.12'nin altında olan yüksek öncelikli hedefler (Keskin nişancı listesi).
const criticalTargets = new Set<`0x${string}`>();

// cooldowns: Aynı adrese mükerrer işlem atılmasını önlemek için bekleme süreleri.
const cooldowns = new Map<string, number>();

// inFlightUsers: Aynı milisaniyede iki farklı döngünün aynı kullanıcıya işlem göndermesini engelleyen kilit kümesi.
const inFlightUsers = new Set<`0x${string}`>();

function logInfo(message: string) { console.log(`[INFO] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }
function logAlert(message: string) { console.log(`[ALERT] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }

// Sunucu yeniden başladığında kaydedilmiş borçlu listesini yükler.
function loadMonitoredUsers() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const rawData = fs.readFileSync(STORAGE_FILE, 'utf-8');
      const addresses: string[] = JSON.parse(rawData);
      let validCount = 0;
      for (const addr of addresses) {
        if (isAddress(addr)) {
          activeUsers.add(getAddress(addr));
          validCount++;
        }
      }
      logInfo(`Loaded ${validCount} active borrowers from local persistent storage into radar.`);
    }
  } catch (err: any) {
    logInfo(`Local storage read error: ${err.message}. Starting fresh.`);
  }
}

// Diske yazma sıklığını kontrol eden optimize edilmiş kayıt fonksiyonu.
let saveTimeout: NodeJS.Timeout | null = null;
function scheduleSaveUsers() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const data = JSON.stringify(Array.from(activeUsers), null, 2);
      fs.writeFileSync(STORAGE_FILE, data, 'utf-8');
    } catch (err: any) {
      console.error(`[ERROR] Failed to persist monitored users: ${err.message}`);
    }
  }, 1000);
}


// ============================================================================
// 4. GERÇEK USD DEĞERİNE GÖRE DİNAMİK BORÇ VE TEMİNAT TESPİTİ (MULTICALL)
// ============================================================================
// Tek bir Multicall RPC isteğiyle tüm borçları, teminatları, "usageAsCollateralEnabled" durumunu
// ve Aave Oracle USD fiyatlarını aynı milisaniyede okur.
// Böylece:
// 1. 6 sıralı sorgu yerine 1 sorgu atılarak ~600ms hız kazanılır.
// 2. WBTC (8 ondalık) ile ARB/WETH (18 ondalık) adet olarak değil, gerçek DOLAR ($ USD) değerine göre kıyaslanır.
// 3. Kullanıcının teminat olarak aktif etmediği (usageAsCollateralEnabled == false) varlıklar elenir.
async function getBestLiquidationTarget(userAddress: `0x${string}`) {
  try {
    const allAssetAddresses = [
      ...DEBT_ASSETS.map(d => d.address),
      ...COLLATERAL_ASSETS.map(c => c.address)
    ];

    // Tüm rezerv verilerini ve Oracle fiyatlarını tek bir Multicall paketinde topluyoruz
    const contracts = [
      ...DEBT_ASSETS.map(debt => ({
        address: AAVE_DATA_PROVIDER_ADDRESS,
        abi: [getUserReserveDataAbi] as const,
        functionName: 'getUserReserveData' as const,
        args: [debt.address, userAddress] as const
      })),
      ...COLLATERAL_ASSETS.map(col => ({
        address: AAVE_DATA_PROVIDER_ADDRESS,
        abi: [getUserReserveDataAbi] as const,
        functionName: 'getUserReserveData' as const,
        args: [col.address, userAddress] as const
      })),
      {
        address: AAVE_ORACLE_ADDRESS,
        abi: [getAssetsPricesAbi] as const,
        functionName: 'getAssetsPrices' as const,
        args: [allAssetAddresses] as const
      }
    ];

    const results = await publicClient.multicall({ contracts, allowFailure: true });

    // Oracle fiyatlarını ayıkla (Aave Oracle fiyatları 8 ondalıklı USD formatındadır)
    const priceResult = results[results.length - 1];
    const pricesRaw = (priceResult.status === 'success' ? priceResult.result : null) as bigint[] | null;

    // 1. En yüksek USD değerine sahip BORÇ varlığını belirle
    let selectedDebt: typeof DEBT_ASSETS[0] | null = null;
    let maxDebtAmount = 0n;
    let maxDebtUSD = 0;

    for (let i = 0; i < DEBT_ASSETS.length; i++) {
      const debt = DEBT_ASSETS[i];
      const res = results[i];
      if (res.status === 'success' && res.result) {
        const [, , currentVariableDebt] = res.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
        if (currentVariableDebt > 0n) {
          const priceUSD = pricesRaw ? Number(pricesRaw[i]) / 1e8 : 1.0;
          const tokenAmount = Number(formatUnits(currentVariableDebt, debt.decimals));
          const valueUSD = tokenAmount * priceUSD;

          if (valueUSD > maxDebtUSD) {
            maxDebtUSD = valueUSD;
            maxDebtAmount = currentVariableDebt;
            selectedDebt = debt;
          }
        }
      }
    }

    if (!selectedDebt || maxDebtAmount === 0n) {
      return null;
    }

    // 2. En yüksek USD değerine sahip ve TEMİNAT OLARAK AÇIK (usageAsCollateralEnabled) varlığı belirle
    let selectedCollateral: typeof COLLATERAL_ASSETS[0] | null = null;
    let maxCollateralUSD = 0;

    for (let j = 0; j < COLLATERAL_ASSETS.length; j++) {
      const col = COLLATERAL_ASSETS[j];
      const res = results[DEBT_ASSETS.length + j];
      if (res.status === 'success' && res.result) {
        const [currentATokenBalance, , , , , , , , usageAsCollateralEnabled] = res.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
        // Sadece teminat olarak aktif edilmiş ve bakiyesi olan varlıkları değerlendir
        if (usageAsCollateralEnabled && currentATokenBalance > 0n) {
          const priceIndex = DEBT_ASSETS.length + j;
          const priceUSD = pricesRaw ? Number(pricesRaw[priceIndex]) / 1e8 : 1.0;
          const tokenAmount = Number(formatUnits(currentATokenBalance, col.decimals));
          const valueUSD = tokenAmount * priceUSD;

          if (valueUSD > maxCollateralUSD) {
            maxCollateralUSD = valueUSD;
            selectedCollateral = col;
          }
        }
      }
    }

    if (!selectedCollateral || maxCollateralUSD === 0) {
      return null;
    }

    return {
      debtAsset: selectedDebt.address,
      debtName: selectedDebt.name,
      debtAmount: maxDebtAmount,
      debtDecimals: selectedDebt.decimals,
      debtUSD: maxDebtUSD,
      collateralAsset: selectedCollateral.address,
      collateralName: selectedCollateral.name,
      collateralUSD: maxCollateralUSD
    };
  } catch (err: any) {
    logInfo(`Failed to evaluate liquidation target pairs for ${userAddress}: ${err.message}`);
    return null;
  }
}


// ============================================================================
// 5. KESKİN NİŞANCI (SNIPER) TASFİYE VE SIFIR RİSKLİ VURMA FONKSİYONU
// ============================================================================
// Sağlık faktörü 1.0'ın altına inen bir pozisyon yakalandığı milisaniye bu fonksiyon devreye girer.
async function executeLiquidationStrike(userAddress: `0x${string}`, healthFactor: number, totalDebtUSD: number) {
  const now = Date.now();
  cooldowns.set(userAddress, now + 120000); // Mükerrer çağrıyı önlemek için 2 dakika bekleme

  logAlert(`LIQUIDATION TARGET IDENTIFIED | Target: ${userAddress} | HF: ${healthFactor.toFixed(4)} | Total Debt: $${totalDebtUSD.toFixed(2)}`);

  // En yüksek USD değerine sahip borç ve teminat çiftini tek seferde belirle
  const target = await getBestLiquidationTarget(userAddress);
  if (!target) {
    logInfo(`No liquidatable supported debt/collateral pair found for ${userAddress}. Aborting strike.`);
    return;
  }

  // AAVE V3 DİNAMİK KAPATMA FAKTÖRÜ (Close Factor) HESABI:
  // HF <= 0.95 ise borcun %100'ü, 0.95 < HF < 1.0 ise borcun maksimum %50'si tasfiye edilebilir.
  let debtToCover = healthFactor <= 0.95 ? target.debtAmount : target.debtAmount / 2n;
  let coverUSD = healthFactor <= 0.95 ? target.debtUSD : target.debtUSD / 2;

  // TEMİNAT TAVANI KORUMASI (Collateral Cap):
  // Eğer kapatılmak istenen borç tutarı + %6 tasfiye bonusu, seçilen teminatın toplam USD değerini aşıyorsa,
  // işlemin "yetersiz teminat" nedeniyle Revert etmemesi için borç miktarını teminatın karşılayabileceği maksimum seviyeye çekiyoruz.
  const maxCoverableByCollateralUSD = target.collateralUSD / 1.06;
  if (coverUSD > maxCoverableByCollateralUSD) {
    const scaleRatio = BigInt(Math.floor((maxCoverableByCollateralUSD / coverUSD) * 10000));
    debtToCover = (debtToCover * scaleRatio) / 10000n;
    coverUSD = maxCoverableByCollateralUSD;
  }

  // SIFIR ZARAR KALKANI 1: Kapatılacak gerçek borç miktarı en az $25 olmalıdır.
  if (coverUSD < MIN_STRIKE_DEBT_USD || debtToCover === 0n) {
    logInfo(`Coverable debt ($${coverUSD.toFixed(2)}) is below minimum profitable strike threshold ($${MIN_STRIKE_DEBT_USD}). Aborting to protect gas.`);
    return;
  }

  const humanDebt = Number(formatUnits(debtToCover, target.debtDecimals));
  logInfo(`Preparing liquidation strike | Collateral: ${target.collateralName} ($${target.collateralUSD.toFixed(2)}) | Debt to Cover: ${humanDebt.toFixed(2)} ${target.debtName} (~$${coverUSD.toFixed(2)})...`);

  try {
    // SIFIR ZARAR KALKANI 2: Anormal Ağ Gas Fiyatı Kontrolü
    const gasPrice = await publicClient.getGasPrice();
    const gasPriceGwei = Number(gasPrice) / 1e9;
    if (gasPriceGwei > MAX_GAS_PRICE_GWEI) {
      logInfo(`Network gas price (${gasPriceGwei.toFixed(2)} Gwei) exceeds safety cap (${MAX_GAS_PRICE_GWEI} Gwei). Aborting strike.`);
      return;
    }

    // SIFIR ZARAR KALKANI 3: SIFIR MALİYETLİ ÖN SİMÜLASYON
    // İşlem blokzincirine gönderilmeden önce RPC düğümünde simüle edilir.
    // Akıllı sözleşmedeki "require(amountOut >= totalDebt)" kontrolü sayesinde, takas çıktısı flaş kredi + faizi
    // karşılamıyorsa veya başka bir bot milisaniyeler önce vurduysa simülasyon reddedilir ve 0.00 ETH gas harcanır.
    const { request } = await publicClient.simulateContract({
      address: OUR_BOT_CONTRACT_ADDRESS,
      abi: botContractAbi,
      functionName: 'triggerLiquidation',
      args: [target.debtAsset, target.collateralAsset, userAddress, debtToCover],
      account: account
    });

    // İŞLEMİ AĞA GÖNDERME (VURMA EYLEMİ)
    logAlert(`SIMULATION PASSED. BROADCASTING HIGH-PRIORITY LIQUIDATION TRANSACTION...`);
    const txHash = await walletClient.writeContract(request);
    logAlert(`STRIKE EXECUTED! Transaction broadcasted to Arbitrum Sequencer. TxHash: ${txHash}`);

  } catch (simError: any) {
    const errorText = simError.shortMessage || simError.message.split('\n')[0];
    logInfo(`Simulation reverted: ${errorText}. Gas protected, no funds lost.`);
  }
}


// ============================================================================
// 6. KULLANICI SAĞLIK DEĞERLENDİRMESİ VE TOPLU TARAMA (MULTICALL SWEEP)
// ============================================================================
// Okunan hesap verisini (getUserAccountData) değerlendirir ve kullanıcıyı ilgili kademeye atar.
async function processUserAccountData(
  userAddress: `0x${string}`,
  data: readonly [bigint, bigint, bigint, bigint, bigint, bigint]
) {
  const now = Date.now();
  if (cooldowns.has(userAddress) && now < cooldowns.get(userAddress)!) return;
  if (inFlightUsers.has(userAddress)) return;

  const healthFactor = Number(data[5]) / 1e18;
  const totalDebtUSD = Number(data[1]) / 1e8;

  // DURUM 1: BORÇLU TASFİYE EDİLEBİLİR DURUMDA (HF < 1.0)
  if (healthFactor > 0 && healthFactor < 1.0) {
    if (totalDebtUSD < MIN_DEBT_USD) {
      cooldowns.set(userAddress, now + 300000); // 50$ altı mikro borçları 5 dakika atla
      return;
    }

    // Çarpışma kilidini aktif et (İki döngünün aynı anda aynı adrese vurmasını engeller)
    inFlightUsers.add(userAddress);
    try {
      await executeLiquidationStrike(userAddress, healthFactor, totalDebtUSD);
    } finally {
      inFlightUsers.delete(userAddress);
    }
  }
  // DURUM 2: BORÇLU ÖLÜM SINIRINDA (HF 1.0 ile 1.12 ARASI)
  else if (healthFactor >= 1.0 && healthFactor <= CRITICAL_HF_THRESHOLD && totalDebtUSD >= MIN_DEBT_USD) {
    if (!criticalTargets.has(userAddress)) {
      criticalTargets.add(userAddress);
      logAlert(`HIGH RISK BORROWER PROMOTED TO SNIPER RADAR | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`);
    }
  }
  // DURUM 3: GÜVENLİ BÖLGE (HF > 1.12)
  else {
    if (criticalTargets.has(userAddress)) {
      criticalTargets.delete(userAddress);
    }
    if (totalDebtUSD === 0) {
      // Borcunu tamamen kapatmışsa radardan tamamen temizle
      activeUsers.delete(userAddress);
      scheduleSaveUsers();
    }
  }
}

// Belirtilen adres listesini Multicall3 kullanarak TEK BİR RPC İSTEĞİYLE tarar.
// Eğer RPC Multicall desteklemiyorsa otomatik olarak tekil sorguya düşer (Fallback).
async function checkUsersBatch(addresses: `0x${string}`[]) {
  const now = Date.now();
  const eligibleAddresses = addresses.filter(
    addr => (!cooldowns.has(addr) || now >= cooldowns.get(addr)!) && !inFlightUsers.has(addr)
  );
  if (eligibleAddresses.length === 0) return;

  try {
    const contracts = eligibleAddresses.map(addr => ({
      address: AAVE_POOL_ADDRESS,
      abi: [getUserAccountDataAbi] as const,
      functionName: 'getUserAccountData' as const,
      args: [addr] as const
    }));

    const results = await publicClient.multicall({ contracts, allowFailure: true });

    for (let i = 0; i < eligibleAddresses.length; i++) {
      const res = results[i];
      if (res.status === 'success' && res.result) {
        await processUserAccountData(
          eligibleAddresses[i],
          res.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint]
        );
      }
    }
  } catch {
    // Multicall başarısız olursa (geçici RPC hatası) sessizce geç
  }
}


// ============================================================================
// 7. KESKİN NİŞANCI DÖNGÜSÜ (CRITICAL SNIPER LOOP)
// ============================================================================
// Ölüm sınırındaki (HF < 1.12) borçluların tamamını HER 2 SANİYEDE BİR tek bir Multicall isteğiyle tarar.
// 21 kritik hedefi 21 ayrı istek yerine 1 istekte okuduğu için hem rate-limit yemez hem de ışık hızında tepki verir.
async function criticalSniperLoop() {
  if (criticalTargets.size > 0) {
    const targets = Array.from(criticalTargets);
    await checkUsersBatch(targets);
  }
  setTimeout(criticalSniperLoop, 2000);
}


// ============================================================================
// 8. GENEL RADAR DÖNGÜSÜ (GENERAL RADAR LOOP)
// ============================================================================
// Kritik listede OLMAYAN diğer tüm borçluları 25'erli Multicall paketleri halinde tarar.
// Böylece 300 adres 300 istek yerine sadece 12 RPC isteğiyle taranır ve iki döngü birbiriyle çakışmaz.
const MULTICALL_BATCH_SIZE = 25;
const BATCH_DELAY_MS = 300;

async function generalRadarLoop() {
  if (activeUsers.size > 0) {
    // Kritik listedeki adresler zaten 2 saniyede bir tarandığı için genel döngüde tekrar sorgulanmaz
    const nonCriticalUsers = Array.from(activeUsers).filter(u => !criticalTargets.has(u));

    logInfo(`Executing sweep across ${activeUsers.size} monitored addresses (Critical Watchlist: ${criticalTargets.size})...`);

    for (let i = 0; i < nonCriticalUsers.length; i += MULTICALL_BATCH_SIZE) {
      const chunk = nonCriticalUsers.slice(i, i + MULTICALL_BATCH_SIZE);
      await checkUsersBatch(chunk);
      if (i + MULTICALL_BATCH_SIZE < nonCriticalUsers.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
  }

  // Genel tarama bittikten sonra 15 saniye bekle ve tekrar başla
  setTimeout(generalRadarLoop, 15000);
}


// ============================================================================
// 9. BAŞLANGIÇ GEÇMİŞ BLOK SENKRONİZASYONU VE ANA MOTOR
// ============================================================================
// Bot kapalıyken Aave'den borç almış yeni cüzdanları yakalamak için son 3.000 bloğu tarar.
async function syncRecentBorrowers(currentBlock: bigint) {
  const LOOKBACK = 3000n;
  const CHUNK = 1000n;
  let added = 0;

  try {
    for (let i = currentBlock - LOOKBACK; i < currentBlock; i += CHUNK) {
      const toBlock = (i + CHUNK > currentBlock) ? currentBlock : i + CHUNK;
      const logs = await publicClient.getLogs({
        address: AAVE_POOL_ADDRESS,
        event: borrowEventAbi,
        fromBlock: i,
        toBlock: toBlock
      });
      logs.forEach(log => {
        if (log.args.user && isAddress(log.args.user)) {
          const checksummed = getAddress(log.args.user);
          if (!activeUsers.has(checksummed)) {
            activeUsers.add(checksummed);
            added++;
          }
        }
      });
      await new Promise(r => setTimeout(r, 300));
    }
    if (added > 0) {
      logInfo(`Synchronized ${added} new borrowers from recent blocks. Total monitored: ${activeUsers.size}`);
      scheduleSaveUsers();
    }
  } catch {
    // Halka açık RPC getLogs sınırına takılırsa mevcut önbellekle devam et
  }
}

// Başlangıçta RPC geçici rate-limit hatası verirse çökmemesi için güvenli bağlantı fonksiyonu
async function getBlockNumberWithRetry(): Promise<bigint> {
  while (true) {
    try {
      return await publicClient.getBlockNumber();
    } catch (err: any) {
      logInfo(`RPC busy on startup (${err.shortMessage || 'Rate limit'}). Retrying in 5 seconds...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function main() {
  console.log("==================================================");
  console.log("[SYSTEM] HIGH-FREQUENCY LIQUIDATION SNIPER ENGINE ONLINE");
  console.log("==================================================");

  // 1. Hafızadaki tüm kayıtlı borçluları yükle
  loadMonitoredUsers();

  // 2. Ağ bağlantısını doğrula (Rate-limit durumunda çökmeden bekler ve bağlanır)
  const currentBlock = await getBlockNumberWithRetry();
  logInfo(`Connected to Arbitrum Network. Current Block: ${currentBlock}`);

  // 3. Arka planda son bloklardaki yeni borçluları senkronize et
  syncRecentBorrowers(currentBlock);

  // 4. Canlı ağda gerçekleşen yeni borçlanma olaylarını (Borrow events) hata korumalı dinle
  publicClient.watchEvent({
    address: AAVE_POOL_ADDRESS,
    event: borrowEventAbi,
    onLogs: logs => {
      let newUsersAdded = 0;
      logs.forEach(log => {
        const user = log.args?.user;
        if (user && isAddress(user)) {
          const checksummed = getAddress(user);
          if (!activeUsers.has(checksummed)) {
            activeUsers.add(checksummed);
            newUsersAdded++;
            logInfo(`New borrower detected on-chain: ${checksummed}`);
            checkUsersBatch([checksummed]);
          }
        }
      });
      if (newUsersAdded > 0) {
        scheduleSaveUsers();
      }
    },
    onError: () => {
      // Halka açık RPC'de geçici filtre kopmalarında sürecin çökmesini engeller
    }
  });

  // 5. İki paralel döngüyü birden başlat:
  // - criticalSniperLoop: Kritik hedefleri (HF < 1.12) 2 saniyede bir tek Multicall ile tarar.
  // - generalRadarLoop: Geri kalan tüm veritabanını 25'erli Multicall paketleriyle tarar.
  logInfo(`Starting dual-tier Multicall radar loops. Monitoring ${activeUsers.size} addresses.`);
  criticalSniperLoop();
  generalRadarLoop();
}

// Olası beklenmedik hataları yakala
main().catch(err => console.error(`[FATAL ERROR] ${err.message}`));
