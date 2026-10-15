import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi, isAddress, getAddress } from 'viem';
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

// Dağıtımı yapılmış olan akıllı tasfiye sözleşmemizin adresi
const OUR_BOT_CONTRACT_ADDRESS = (process.env.BOT_CONTRACT_ADDRESS) as `0x${string}`;

// MİKRO BORÇ FİLTRESİ:
// Gas masrafı tasfiye bonusundan yüksek çıkacak önemsiz borçları ($50 altı) eler.
const MIN_DEBT_USD = 50.0;

// KRİTİK TAKİP EŞİĞİ (Keskin Nişancı Eşiği):
// Sağlık Faktörü (HF) bu değerin altına inen borçlular "Kritik Radara" alınır ve saniyeler içinde taranır.
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

// Desteklenen Teminat Varlıkları (Kullanıcının Aave'ye rehin koyduğu ve bizim %5 indirimle alacağımız varlıklar)
const COLLATERAL_ASSETS = [
  {
    name: 'WETH',
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as `0x${string}`,
    aToken: '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8' as `0x${string}`
  },
  {
    name: 'WBTC',
    address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as `0x${string}`,
    aToken: '0x078f358208685046a11C85e8ad32895DED33A249' as `0x${string}`
  },
  {
    name: 'ARB',
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548' as `0x${string}`,
    aToken: '0x6533afac2E7BCCB20dca161449A13A32D391fb00' as `0x${string}`
  }
];

// Aave ve Akıllı Sözleşme Arayüz Tanımları (ABI)
const getUserAccountDataAbi = parseAbiItem('function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)');
const borrowEventAbi = parseAbiItem('event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)');
const erc20BalanceOfAbi = parseAbiItem('function balanceOf(address account) view returns (uint256)');
const botContractAbi = parseAbi([
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover) external',
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover, uint24 poolFee) external'
]);


// ============================================================================
// 3. KALICI HAFIZA VE KULLANICI RADARI
// ============================================================================
const DATA_DIR = path.join(__dirname, '../data');
const STORAGE_FILE = path.join(DATA_DIR, 'monitored_users.json');

// activeUsers: Radardaki tüm borçlu adresleri.
const activeUsers = new Set<`0x${string}`>();

// criticalTargets: Sağlık faktörü 1.12'nin altında olan yüksek öncelikli hedefler (Keskin nişancı listesi).
const criticalTargets = new Set<`0x${string}`>();

// cooldowns: Aynı adrese mükerrer işlem atılmasını önlemek için bekleme süreleri.
const cooldowns = new Map<string, number>();

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
// 4. DİNAMİK BORÇ VE TEMİNAT TESPİTİ (EN YÜKSEK KÂRI HESAPLAMA)
// ============================================================================
// Borçlunun cüzdanındaki en büyük borcu ve en değerli teminatı bularak tasfiyenin kârını maksimize eder.
async function getBestLiquidationTarget(userAddress: `0x${string}`) {
  // 1. Borç varlığını belirle (Native USDC, USDC.e veya USDT)
  let selectedDebt: typeof DEBT_ASSETS[0] | null = null;
  let maxDebtAmount = 0n;

  for (const debt of DEBT_ASSETS) {
    try {
      const balance = await publicClient.readContract({
        address: debt.variableDebtToken,
        abi: [erc20BalanceOfAbi],
        functionName: 'balanceOf',
        args: [userAddress]
      }) as bigint;

      if (balance > maxDebtAmount) {
        maxDebtAmount = balance;
        selectedDebt = debt;
      }
    } catch {
      // Bir varlık sorgulanırken hata olursa diğerine devam et
    }
  }

  if (!selectedDebt || maxDebtAmount === 0n) {
    return null;
  }

  // 2. Teminat varlığını belirle (WETH, WBTC veya ARB)
  let selectedCollateral: typeof COLLATERAL_ASSETS[0] | null = null;
  let maxCollateralAmount = 0n;

  for (const col of COLLATERAL_ASSETS) {
    try {
      const balance = await publicClient.readContract({
        address: col.aToken,
        abi: [erc20BalanceOfAbi],
        functionName: 'balanceOf',
        args: [userAddress]
      }) as bigint;

      if (balance > maxCollateralAmount) {
        maxCollateralAmount = balance;
        selectedCollateral = col;
      }
    } catch {
      // Bir varlık sorgulanırken hata olursa diğerine devam et
    }
  }

  // Teminat bulunamazsa derinliği en yüksek WETH varsayılan alınır
  if (!selectedCollateral || maxCollateralAmount === 0n) {
    selectedCollateral = COLLATERAL_ASSETS[0];
  }

  return {
    debtAsset: selectedDebt.address,
    debtName: selectedDebt.name,
    debtAmount: maxDebtAmount,
    debtDecimals: selectedDebt.decimals,
    collateralAsset: selectedCollateral.address,
    collateralName: selectedCollateral.name
  };
}


// ============================================================================
// 5. KESKİN NİŞANCI (SNIPER) TASFİYE VE VURMA FONKSİYONU
// ============================================================================
// Sağlık faktörü 1.0'ın altına inen bir pozisyon yakalandığı milisaniye bu fonksiyon devreye girer.
async function executeLiquidationStrike(userAddress: `0x${string}`, healthFactor: number, totalDebtUSD: number) {
  const now = Date.now();
  cooldowns.set(userAddress, now + 120000); // Mükerrer çağrıyı önlemek için 2 dakika bekleme

  logAlert(`LIQUIDATION TARGET IDENTIFIED | Target: ${userAddress} | HF: ${healthFactor.toFixed(4)} | Total Debt: $${totalDebtUSD.toFixed(2)}`);

  // En yüksek getiriyi sağlayacak borç ve teminat çiftini belirle
  const target = await getBestLiquidationTarget(userAddress);
  if (!target) {
    logInfo(`No liquidatable debt token found for ${userAddress}. Aborting strike.`);
    return;
  }

  // Aave V3 Kuralı: Borcun tam olarak %50'si (Maksimum Kapatma Faktörü) tasfiye edilir
  const debtToCover = target.debtAmount / 2n;
  const humanDebt = Number(debtToCover) / Math.pow(10, target.debtDecimals);

  logInfo(`Preparing liquidation strike | Collateral: ${target.collateralName} | Debt to Cover: ${humanDebt.toFixed(2)} ${target.debtName}...`);

  try {
    // 1. ADIM: SIFIR MALİYETLİ ÖN SİMÜLASYON
    // Gerçek işlem blokzincirine fırlatılmadan önce düğümde (RPC) simüle edilir.
    // Eğer işlem kârlı değilse veya bir başka bot milisaniyeler önce tasfiye ettiyse, simülasyon reddedilir ve 1 kuruş dahi gas masrafı ödenmez!
    const { request } = await publicClient.simulateContract({
      address: OUR_BOT_CONTRACT_ADDRESS,
      abi: botContractAbi,
      functionName: 'triggerLiquidation',
      args: [target.debtAsset, target.collateralAsset, userAddress, debtToCover],
      account: account
    });

    // 2. ADIM: İŞLEMİ AĞA GÖNDERME (VURMA EYLEMİ)
    logAlert(`SIMULATION PASSED. BROADCASTING HIGH-PRIORITY LIQUIDATION TRANSACTION...`);
    const txHash = await walletClient.writeContract(request);
    logAlert(`STRIKE EXECUTED! Transaction broadcasted to Arbitrum Sequencer. TxHash: ${txHash}`);

  } catch (simError: any) {
    const errorText = simError.shortMessage || simError.message.split('\n')[0];
    logInfo(`Simulation reverted: ${errorText}. Gas protected, no funds lost.`);
  }
}


// ============================================================================
// 6. KULLANICI SAĞLIK SORGUSU VE KADEMELENDİRME
// ============================================================================
async function checkUser(userAddress: `0x${string}`) {
  const now = Date.now();
  if (cooldowns.has(userAddress) && now < cooldowns.get(userAddress)!) return;

  try {
    // Aave havuzundan kullanıcının anlık borç, teminat ve sağlık faktörünü oku
    const data = await publicClient.readContract({
      address: AAVE_POOL_ADDRESS,
      abi: [getUserAccountDataAbi],
      functionName: 'getUserAccountData',
      args: [userAddress]
    }) as [bigint, bigint, bigint, bigint, bigint, bigint];

    const healthFactor = Number(data[5]) / 1e18;
    const totalDebtUSD = Number(data[1]) / 1e8;

    // DURUM 1: BORÇLU TASFİYE EDİLEBİLİR DURUMDA (HF < 1.0)
    if (healthFactor > 0 && healthFactor < 1.0) {
      if (totalDebtUSD < MIN_DEBT_USD) {
        cooldowns.set(userAddress, now + 300000); // 50$ altı mikro borçları 5 dakika atla
        return;
      }
      // VURMA EYLEMİNİ DERHAL BAŞLAT
      await executeLiquidationStrike(userAddress, healthFactor, totalDebtUSD);
    } 
    // DURUM 2: BORÇLU ÖLÜM SINIRINDA (HF 1.0 ile 1.12 ARASI)
    else if (healthFactor >= 1.0 && healthFactor <= CRITICAL_HF_THRESHOLD && totalDebtUSD >= MIN_DEBT_USD) {
      // Bu kullanıcıyı "Kritik Hedefler Listesi"ne ekle. Saniyeler içinde tekrar taranacak!
      if (!criticalTargets.has(userAddress)) {
        criticalTargets.add(userAddress);
        logAlert(`HIGH RISK BORROWER PROMOTED TO SNIPER RADAR | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`);
      }
    } 
    // DURUM 3: GÜVENLİ BÖLGE (HF > 1.12)
    else {
      // Risk azaldıysa kritik listeden çıkar, genel radarda tut
      if (criticalTargets.has(userAddress)) {
        criticalTargets.delete(userAddress);
      }
      if (totalDebtUSD === 0) {
        // Borcunu tamamen kapatmışsa radardan tamamen temizle
        activeUsers.delete(userAddress);
        scheduleSaveUsers();
      }
    }
  } catch (error) {
    // Geçici ağ ve sorgu hatalarını yoksay
  }
}


// ============================================================================
// 7. KESKİN NİŞANCI DÖNGÜSÜ (CRITICAL SNIPER LOOP)
// ============================================================================
// Ölüm sınırındaki (HF < 1.12) borçluları HER 2 SANİYEDE BİR tarar.
// Piyasa %1-2 gerilediğinde diğer tüm botlardan önce ilk vuruşu yapmamızı sağlayan asıl motor burasıdır.
async function criticalSniperLoop() {
  if (criticalTargets.size > 0) {
    const targets = Array.from(criticalTargets);
    // Kritik hedefleri hemen paralel tara
    await Promise.allSettled(targets.map(target => checkUser(target)));
  }
  // 2 saniye sonra tekrar tara (Işık hızında tepki)
  setTimeout(criticalSniperLoop, 2000);
}


// ============================================================================
// 8. GENEL RADAR DÖNGÜSÜ (GENERAL RADAR LOOP)
// ============================================================================
// Radardaki tüm borçluları (300+ adres) 5'erli paketler halinde düzenli tarayarak
// yeni riskli borçluları tespit eder ve kritik listeye terfi ettirir.
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;

async function generalRadarLoop() {
  if (activeUsers.size > 0) {
    logInfo(`Executing sweep across ${activeUsers.size} monitored addresses (Critical Watchlist: ${criticalTargets.size})...`);
    const userList = Array.from(activeUsers);

    for (let i = 0; i < userList.length; i += BATCH_SIZE) {
      const chunk = userList.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(chunk.map(user => checkUser(user)));
      if (i + BATCH_SIZE < userList.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
  }

  // Genel tarama bittikten sonra 10 saniye bekle ve tekrar başla
  setTimeout(generalRadarLoop, 10000);
}


// ============================================================================
// 9. ANA ÇALIŞTIRMA VE CANLI AĞ DİNLEYİCİSİ
// ============================================================================
async function main() {
  console.log("==================================================");
  console.log("[SYSTEM] HIGH-FREQUENCY LIQUIDATION SNIPER ENGINE ONLINE");
  console.log("==================================================");

  // 1. Hafızadaki tüm kayıtlı borçluları yükle
  loadMonitoredUsers();

  const currentBlock = await publicClient.getBlockNumber();
  logInfo(`Connected to Arbitrum Network. Current Block: ${currentBlock}`);

  // 2. Canlı ağda gerçekleşen yeni borçlanma olaylarını (Borrow events) dinle
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
            // Yeni borçluyu anında ilk kontrolden geçir
            checkUser(checksummed);
          }
        }
      });
      if (newUsersAdded > 0) {
        scheduleSaveUsers();
      }
    }
  });

  // 3. İki paralel döngüyü birden başlat:
  // - criticalSniperLoop: Kritik hedefleri 2 saniyede bir tarar.
  // - generalRadarLoop: Tüm veritabanını 10 saniyede bir tarar.
  logInfo(`Starting dual-tier radar loops. Monitoring ${activeUsers.size} addresses.`);
  criticalSniperLoop();
  generalRadarLoop();
}

// Olası beklenmedik hataları yakala
main().catch(err => console.error(`[FATAL ERROR] ${err.message}`));
