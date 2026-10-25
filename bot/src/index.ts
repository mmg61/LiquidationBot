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

// 3 KADEMELİ RADAR EŞİKLERİ:
// 1. Ultra-Kritik Eşik (HF < 1.045): Tasfiyeye %1-%4 kalmış hedefler -> HER 400 MİLİSANİYEDE BİR taranır ve mermisi önceden hazırlanır (Pre-Cached).
const ULTRA_CRITICAL_HF_THRESHOLD = 1.045;
// 2. Kritik Takip Eşiği (1.045 <= HF <= 1.12): Yakın riskteki hedefler -> HER 3 SANİYEDE BİR taranır.
const CRITICAL_HF_THRESHOLD = 1.12;

// Aave V3 Arbitrum Üzerindeki Tüm Ana Rezerv Varlıkları (Hem Borç Hem Teminat Olarak Taranır)
interface ReserveAsset {
  name: string;
  address: `0x${string}`;
  decimals: number;
}

const AAVE_RESERVE_ASSETS: ReserveAsset[] = [
  { name: 'USDC (Native)',    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  { name: 'USDC.e (Bridged)', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6 },
  { name: 'USDT',             address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  { name: 'DAI',              address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
  { name: 'WETH',             address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  { name: 'WBTC',             address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
  { name: 'wstETH',           address: '0x5979D7b546E38E414F7E9822514be443A4800529', decimals: 18 },
  { name: 'weETH',            address: '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', decimals: 18 },
  { name: 'ARB',              address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  { name: 'LINK',             address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18 },
  { name: 'AAVE',             address: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', decimals: 18 }
];

// Aave, Oracle ve Akıllı Sözleşme Arayüz Tanımları (ABI)
const getUserAccountDataAbi = parseAbiItem('function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)');
const getUserReserveDataAbi = parseAbiItem('function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)');
const getAssetsPricesAbi = parseAbiItem('function getAssetsPrices(address[] assets) view returns (uint256[])');
const borrowEventAbi = parseAbiItem('event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)');
const liquidationCallEventAbi = parseAbiItem('event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)');
const botContractAbi = parseAbi([
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover) external',
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover, uint24 poolFee) external'
]);


// ============================================================================
// 3. KALICI HAFIZA, 3 KADEMELİ RADAR VE ÖN-HAZIRLIK ÖNBELLEĞİ (PRE-CACHE)
// ============================================================================
const DATA_DIR = path.join(__dirname, '../data');
const STORAGE_FILE = path.join(DATA_DIR, 'monitored_users.json');

// activeUsers: Radardaki tüm borçlu adresleri.
const activeUsers = new Set<`0x${string}`>();

// ultraCriticalTargets: HF < 1.045 olan ve 400 milisaniyede 1 kez taranan ölüm sınırındaki hedefler.
const ultraCriticalTargets = new Set<`0x${string}`>();

// criticalTargets: 1.045 <= HF <= 1.12 olan ve 3 saniyede 1 kez taranan hedefler.
const criticalTargets = new Set<`0x${string}`>();

// cooldowns: Aynı adrese mükerrer işlem atılmasını önlemek için bekleme süreleri.
const cooldowns = new Map<string, number>();

// inFlightUsers: Aynı milisaniyede iki farklı döngünün aynı kullanıcıya işlem göndermesini engelleyen kilit kümesi.
const inFlightUsers = new Set<`0x${string}`>();

interface LiquidationCandidate {
  debtAsset: `0x${string}`;
  debtName: string;
  debtAmount: bigint;
  debtDecimals: number;
  debtUSD: number;
  collateralAsset: `0x${string}`;
  collateralName: string;
  collateralUSD: number;
}

// targetStrikeCache: Ultra-Kritik hedeflerin borç/teminat çiftlerini HF < 1.0 olmadan ÖNCE bellekte hazır tutar.
// Bu sayede HF < 1.0 olduğu milisaniye token aramakla 450ms vakit kaybedilmez, doğrudan simülasyon ve vuruş yapılır!
const targetStrikeCache = new Map<`0x${string}`, { candidates: LiquidationCandidate[]; updatedAt: number }>();

function logInfo(message: string) { console.log(`[INFO] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }
function logAlert(message: string) { console.log(`[ALERT] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }

// Sunucu yeniden başladığında kaydedilmiş borçlu listesini yükler; dosya yoksa otomatik oluşturur.
function loadMonitoredUsers() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORAGE_FILE)) {
      fs.writeFileSync(STORAGE_FILE, JSON.stringify([], null, 2), 'utf-8');
      logInfo(`Created new empty persistent storage file at ${STORAGE_FILE}`);
      return;
    }
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
// 4. GERÇEK USD DEĞERİNE GÖRE ÇOKLU ADAY ÇİFT TESPİTİ (MULTICALL)
// ============================================================================
// Tek bir Multicall RPC isteğiyle 11 ana Aave varlığının tamamı için borçları, teminatları,
// "usageAsCollateralEnabled" durumunu ve Aave Oracle USD fiyatlarını aynı milisaniyede okur.
async function getLiquidationCandidates(userAddress: `0x${string}`): Promise<LiquidationCandidate[]> {
  try {
    const allAssetAddresses = AAVE_RESERVE_ASSETS.map(a => a.address);

    const contracts = [
      ...AAVE_RESERVE_ASSETS.map(asset => ({
        address: AAVE_DATA_PROVIDER_ADDRESS,
        abi: [getUserReserveDataAbi] as const,
        functionName: 'getUserReserveData' as const,
        args: [asset.address, userAddress] as const
      })),
      {
        address: AAVE_ORACLE_ADDRESS,
        abi: [getAssetsPricesAbi] as const,
        functionName: 'getAssetsPrices' as const,
        args: [allAssetAddresses] as const
      }
    ];

    const results = await publicClient.multicall({ contracts, allowFailure: true });

    const priceResult = results[results.length - 1];
    const pricesRaw = (priceResult.status === 'success' ? priceResult.result : null) as bigint[] | null;

    const userDebts: { asset: ReserveAsset; amount: bigint; usd: number }[] = [];
    const userCollaterals: { asset: ReserveAsset; usd: number }[] = [];

    for (let i = 0; i < AAVE_RESERVE_ASSETS.length; i++) {
      const asset = AAVE_RESERVE_ASSETS[i];
      const res = results[i];
      if (res.status === 'success' && res.result) {
        const [currentATokenBalance, currentStableDebt, currentVariableDebt, , , , , , usageAsCollateralEnabled] =
          res.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];

        const priceUSD = pricesRaw ? Number(pricesRaw[i]) / 1e8 : 1.0;

        // Toplam borç bakiyesi (Değişken + Sabit borç)
        const totalAssetDebt = currentVariableDebt + currentStableDebt;
        if (totalAssetDebt > 0n) {
          const debtTokenAmount = Number(formatUnits(totalAssetDebt, asset.decimals));
          const debtValueUSD = debtTokenAmount * priceUSD;
          if (debtValueUSD >= MIN_STRIKE_DEBT_USD) {
            userDebts.push({ asset, amount: totalAssetDebt, usd: debtValueUSD });
          }
        }

        // Teminat olarak aktif edilmiş ve bakiyesi olan varlıklar
        if (usageAsCollateralEnabled && currentATokenBalance > 0n) {
          const colTokenAmount = Number(formatUnits(currentATokenBalance, asset.decimals));
          const colValueUSD = colTokenAmount * priceUSD;
          if (colValueUSD >= MIN_STRIKE_DEBT_USD) {
            userCollaterals.push({ asset, usd: colValueUSD });
          }
        }
      }
    }

    if (userDebts.length === 0 || userCollaterals.length === 0) {
      return [];
    }

    userDebts.sort((a, b) => b.usd - a.usd);
    userCollaterals.sort((a, b) => b.usd - a.usd);

    const candidates: LiquidationCandidate[] = [];
    for (const d of userDebts) {
      for (const c of userCollaterals) {
        if (d.asset.address.toLowerCase() !== c.asset.address.toLowerCase()) {
          candidates.push({
            debtAsset: d.asset.address,
            debtName: d.asset.name,
            debtAmount: d.amount,
            debtDecimals: d.asset.decimals,
            debtUSD: d.usd,
            collateralAsset: c.asset.address,
            collateralName: c.asset.name,
            collateralUSD: c.usd
          });
        }
      }
    }

    candidates.sort((a, b) => Math.min(b.debtUSD, b.collateralUSD) - Math.min(a.debtUSD, a.collateralUSD));
    const topCandidates = candidates.slice(0, 3);
    if (topCandidates.length > 0) {
      targetStrikeCache.set(userAddress, { candidates: topCandidates, updatedAt: Date.now() });
    }
    return topCandidates;
  } catch (err: any) {
    logInfo(`Failed to evaluate liquidation candidates for ${userAddress}: ${err.message}`);
    return [];
  }
}


// ============================================================================
// 5. KESKİN NİŞANCI (SNIPER) TASFİYE VE SIFIR RİSKLİ VURMA FONKSİYONU
// ============================================================================
// Sağlık faktörü 1.0'ın altına inen bir pozisyon yakalandığı milisaniye bu fonksiyon devreye girer.
async function executeLiquidationStrike(userAddress: `0x${string}`, healthFactor: number, totalDebtUSD: number) {
  const now = Date.now();
  // Simülasyon reddedilirse 3 saniye sonra tekrar dene
  cooldowns.set(userAddress, now + 3000);

  logAlert(`LIQUIDATION TARGET IDENTIFIED | Target: ${userAddress} | HF: ${healthFactor.toFixed(4)} | Total Debt: $${totalDebtUSD.toFixed(2)}`);

  // ÖN-HAZIRLIK ÖNBELLEĞİ (0ms Gecikme):
  // Eğer hedef Ultra-Kritik listedeyken borç/teminat çiftleri son 60 saniye içinde önbelleğe alındıysa,
  // 450ms süren RPC sorgusunu atla ve doğrudan önbellekteki hazır mermiyle vur!
  const cached = targetStrikeCache.get(userAddress);
  const candidates = (cached && (now - cached.updatedAt < 60000))
    ? cached.candidates
    : await getLiquidationCandidates(userAddress);

  if (candidates.length === 0) {
    logInfo(`No liquidatable distinct debt/collateral pair found for ${userAddress}.`);
    cooldowns.set(userAddress, now + 30000);
    return;
  }

  for (const target of candidates) {
    let fullDebtToCover = healthFactor <= 0.95 ? target.debtAmount : target.debtAmount / 2n;
    let fullCoverUSD = healthFactor <= 0.95 ? target.debtUSD : target.debtUSD / 2;

    const maxCoverableByCollateralUSD = target.collateralUSD / 1.06;
    if (fullCoverUSD > maxCoverableByCollateralUSD) {
      const scaleRatio = BigInt(Math.floor((maxCoverableByCollateralUSD / fullCoverUSD) * 10000));
      fullDebtToCover = (fullDebtToCover * scaleRatio) / 10000n;
      fullCoverUSD = maxCoverableByCollateralUSD;
    }

    if (fullCoverUSD < MIN_STRIKE_DEBT_USD || fullDebtToCover === 0n) {
      continue;
    }

    const strikeAttempts: { amount: bigint; usd: number; label: string }[] = [
      { amount: fullDebtToCover, usd: fullCoverUSD, label: 'FULL' }
    ];
    if (fullCoverUSD >= 10000) {
      strikeAttempts.push({
        amount: fullDebtToCover / 4n,
        usd: fullCoverUSD / 4,
        label: 'PARTIAL-25%'
      });
    }

    for (const attempt of strikeAttempts) {
      const humanDebt = Number(formatUnits(attempt.amount, target.debtDecimals));
      logInfo(`Simulating [${attempt.label}] strike | Pair: ${target.collateralName} -> ${target.debtName} | Covering: ${humanDebt.toFixed(4)} ${target.debtName} (~$${attempt.usd.toFixed(2)})...`);

      try {
        // SIFIR ZARAR KALKANI: SIFIR MALİYETLİ ÖN SİMÜLASYON
        const { request } = await publicClient.simulateContract({
          address: OUR_BOT_CONTRACT_ADDRESS,
          abi: botContractAbi,
          functionName: 'triggerLiquidation',
          args: [target.debtAsset, target.collateralAsset, userAddress, attempt.amount],
          account: account
        });

        // SİMÜLASYON BAŞARILI! GAS TAVANINI KONTROL ET VE DERHAL AĞA GÖNDER
        const gasPrice = await publicClient.getGasPrice();
        const gasPriceGwei = Number(gasPrice) / 1e9;
        if (gasPriceGwei > MAX_GAS_PRICE_GWEI) {
          logInfo(`Network gas price (${gasPriceGwei.toFixed(2)} Gwei) exceeds safety cap (${MAX_GAS_PRICE_GWEI} Gwei). Aborting strike.`);
          return;
        }

        logAlert(`SIMULATION PASSED! BROADCASTING LIQUIDATION TRANSACTION (${target.collateralName} -> ${target.debtName})...`);
        const txHash = await walletClient.writeContract(request);
        logAlert(`STRIKE EXECUTED SUCCESSFULLY! TxHash: ${txHash}`);

        cooldowns.set(userAddress, Date.now() + 60000);
        return;
      } catch (simError: any) {
        const errorText = simError.shortMessage || simError.message.split('\n')[0];
        logInfo(`Simulation reverted (${target.collateralName} -> ${target.debtName} [${attempt.label}]): ${errorText}`);
      }
    }
  }
}


// ============================================================================
// 6. KULLANICI SAĞLIK DEĞERLENDİRMESİ VE 3 KADEMELİ SINIFLANDIRMA
// ============================================================================
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
      cooldowns.set(userAddress, now + 300000);
      return;
    }

    inFlightUsers.add(userAddress);
    try {
      await executeLiquidationStrike(userAddress, healthFactor, totalDebtUSD);
    } finally {
      inFlightUsers.delete(userAddress);
    }
  }
  // DURUM 2: ULTRA-KRİTİK BÖLGE (1.0 <= HF < 1.045) -> HER 400ms'DE BİR TARANACAK + MERMİSİ ÖNCEDEN HAZIRLANACAK!
  else if (healthFactor >= 1.0 && healthFactor < ULTRA_CRITICAL_HF_THRESHOLD && totalDebtUSD >= MIN_DEBT_USD) {
    criticalTargets.delete(userAddress);
    if (!ultraCriticalTargets.has(userAddress)) {
      ultraCriticalTargets.add(userAddress);
      logAlert(`ULTRA-CRITICAL TARGET LOCKED (400ms Poll) | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`);
    }
    // Hedefin borç/teminat yapısını önceden önbelleğe al (HF < 1.0 olduğunda 0ms gecikmeyle vurmak için)
    const cached = targetStrikeCache.get(userAddress);
    if (!cached || now - cached.updatedAt > 45000) {
      getLiquidationCandidates(userAddress).catch(() => {});
    }
  }
  // DURUM 3: KRİTİK BÖLGE (1.045 <= HF <= 1.12) -> HER 3 SANİYEDE BİR TARANACAK!
  else if (healthFactor >= ULTRA_CRITICAL_HF_THRESHOLD && healthFactor <= CRITICAL_HF_THRESHOLD && totalDebtUSD >= MIN_DEBT_USD) {
    ultraCriticalTargets.delete(userAddress);
    if (!criticalTargets.has(userAddress)) {
      criticalTargets.add(userAddress);
      logAlert(`HIGH RISK BORROWER PROMOTED TO SNIPER RADAR | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`);
    }
  }
  // DURUM 4: GÜVENLİ BÖLGE (HF > 1.12)
  else {
    ultraCriticalTargets.delete(userAddress);
    criticalTargets.delete(userAddress);
    targetStrikeCache.delete(userAddress);
    if (totalDebtUSD === 0) {
      activeUsers.delete(userAddress);
      scheduleSaveUsers();
    }
  }
}

// Belirtilen adres listesini Multicall3 kullanarak TEK BİR RPC İSTEĞİYLE tarar.
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
    // Geçici RPC hatalarını sessizce geç
  }
}


// ============================================================================
// 7. 3 KADEMELİ KESKİN NİŞANCI VE RADAR DÖNGÜLERİ
// ============================================================================
// Kademe 1: Ultra-Kritik hedefleri (HF < 1.045) HER 400 MİLİSANİYEDE BİR tek Multicall ile tarar.
async function ultraCriticalSniperLoop() {
  if (ultraCriticalTargets.size > 0) {
    const targets = Array.from(ultraCriticalTargets);
    await checkUsersBatch(targets);
  }
  setTimeout(ultraCriticalSniperLoop, 400);
}

// Kademe 2: Kritik hedefleri (1.045 <= HF <= 1.12) HER 3 SANİYEDE BİR tek Multicall ile tarar.
async function criticalSniperLoop() {
  if (criticalTargets.size > 0) {
    const targets = Array.from(criticalTargets);
    await checkUsersBatch(targets);
  }
  setTimeout(criticalSniperLoop, 3000);
}

// Kademe 3: Genel listedeki diğer borçluları 25'erli Multicall paketleri halinde tarar.
const MULTICALL_BATCH_SIZE = 25;
const BATCH_DELAY_MS = 300;

async function generalRadarLoop() {
  if (activeUsers.size > 0) {
    const nonCriticalUsers = Array.from(activeUsers).filter(
      u => !ultraCriticalTargets.has(u) && !criticalTargets.has(u)
    );

    logInfo(`Executing sweep across ${activeUsers.size} monitored addresses (Ultra-Critical [400ms]: ${ultraCriticalTargets.size} | Critical [3s]: ${criticalTargets.size})...`);

    for (let i = 0; i < nonCriticalUsers.length; i += MULTICALL_BATCH_SIZE) {
      const chunk = nonCriticalUsers.slice(i, i + MULTICALL_BATCH_SIZE);
      await checkUsersBatch(chunk);
      if (i + MULTICALL_BATCH_SIZE < nonCriticalUsers.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
  }

  setTimeout(generalRadarLoop, 15000);
}


// ============================================================================
// 8. BAŞLANGIÇ GEÇMİŞ BLOK SENKRONİZASYONU VE ANA MOTOR
// ============================================================================
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

  // 2. Ağ bağlantısını doğrula
  const currentBlock = await getBlockNumberWithRetry();
  logInfo(`Connected to Arbitrum Network. Current Block: ${currentBlock}`);

  // 3. Arka planda son bloklardaki yeni borçluları senkronize et
  syncRecentBorrowers(currentBlock);

  // 4. Canlı ağda gerçekleşen yeni borçlanma olaylarını dinle
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
    onError: () => {}
  });

  // 5. Ağdaki gerçek tasfiye olaylarını (LiquidationCall) izle:
  // Ağda başka bir bot tasfiye yaptığında hedefin bizim radarımızda olup olmadığını raporlar ve adresi radara ekler.
  publicClient.watchEvent({
    address: AAVE_POOL_ADDRESS,
    event: liquidationCallEventAbi,
    onLogs: logs => {
      logs.forEach(log => {
        const user = log.args?.user;
        const liquidator = log.args?.liquidator;
        if (user && isAddress(user)) {
          const checksummed = getAddress(user);
          const inRadar = activeUsers.has(checksummed);
          logAlert(`ON-CHAIN LIQUIDATION OBSERVED | User: ${checksummed} | In Our Radar: ${inRadar ? 'YES' : 'NO'} | Liquidator: ${liquidator}`);
          if (!inRadar) {
            activeUsers.add(checksummed);
            scheduleSaveUsers();
          }
          checkUsersBatch([checksummed]);
        }
      });
    },
    onError: () => {}
  });

  // 6. Üç paralel kademeli döngüyü birden başlat:
  // - ultraCriticalSniperLoop: HF < 1.045 olanları 400 milisaniyede bir tarar.
  // - criticalSniperLoop: 1.045 <= HF <= 1.12 olanları 3 saniyede bir tarar.
  // - generalRadarLoop: Tüm veritabanını 25'erli Multicall paketleriyle tarar.
  logInfo(`Starting 3-tier Multicall radar loops. Monitoring ${activeUsers.size} addresses.`);
  ultraCriticalSniperLoop();
  criticalSniperLoop();
  generalRadarLoop();
}

main().catch(err => console.error(`[FATAL ERROR] ${err.message}`));
