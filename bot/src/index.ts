import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbiItem,
  parseAbi,
  isAddress,
  getAddress,
  formatUnits
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, localhost } from 'viem/chains';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Ortam değişkenlerini (.env dosyasından) yükler.
dotenv.config();

// ============================================================================
// 1. AĞ, ÇOKLU RPC HAVUZU VE CÜZDAN YAPILANDIRMASI
// ============================================================================
const primaryRpcUrl =
  process.env.LOCAL_FORK_URL || process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  console.error('[ERROR] PRIVATE_KEY not found in .env file.');
  process.exit(1);
}

const account = privateKeyToAccount(
  privateKey.startsWith('0x') ? (privateKey as `0x${string}`) : `0x${privateKey}`
);
const chainToUse = process.env.LOCAL_FORK_URL ? localhost : arbitrum;

// Viem fallback transport ile otomatik yedekli ana okuma istemcisi
const publicClient = createPublicClient({
  chain: chainToUse,
  transport: process.env.LOCAL_FORK_URL
    ? http(primaryRpcUrl, { timeout: 10000 })
    : fallback([
        http(primaryRpcUrl, { timeout: 10000 }),
        http('https://arbitrum-one-rpc.publicnode.com', { timeout: 10000 }),
        http('https://arb1.arbitrum.io/rpc', { timeout: 10000 })
      ])
});

// Çoklu Okuma Havuzu (Round-Robin): 250ms (blok hızı) taramalarda tek bir RPC'nin kotasını doldurmamak için yükü dağıtır.
const readClients = process.env.LOCAL_FORK_URL
  ? [publicClient]
  : [
      createPublicClient({
        chain: arbitrum,
        transport: http(primaryRpcUrl, { timeout: 10000 })
      }),
      createPublicClient({
        chain: arbitrum,
        transport: http('https://arbitrum-one-rpc.publicnode.com', { timeout: 10000 })
      }),
      createPublicClient({
        chain: arbitrum,
        transport: http('https://arb1.arbitrum.io/rpc', { timeout: 10000 })
      })
    ];

let readClientIndex = 0;
function getNextReadClient() {
  const client = readClients[readClientIndex % readClients.length];
  readClientIndex++;
  return client;
}

// Çoklu Yazma (Broadcast) Havuzu: İşlemi aynı milisaniyede hem doğrudan Arbitrum Resmi Sequencer'ına hem de alternatif düğümlere ateşler.
const broadcastWalletClients = process.env.LOCAL_FORK_URL
  ? [createWalletClient({ account, chain: chainToUse, transport: http(primaryRpcUrl) })]
  : [
      createWalletClient({
        account,
        chain: arbitrum,
        transport: http('https://arb1.arbitrum.io/rpc', { timeout: 8000 })
      }),
      createWalletClient({
        account,
        chain: arbitrum,
        transport: http('https://arbitrum-one-rpc.publicnode.com', { timeout: 8000 })
      }),
      createWalletClient({
        account,
        chain: arbitrum,
        transport: http(primaryRpcUrl, { timeout: 8000 })
      })
    ];

// VURUŞ ANINDA 0ms GECİKME İÇİN ÖN-BELLEKLİ NONCE VE GAS PARAMETRELERİ:
let cachedGasPriceWei = 20000000n; // Varsayılan 0.02 Gwei
let cachedGasPriceGwei = 0.02;
let cachedNonce: number | undefined = undefined;

async function refreshExecutionParams() {
  try {
    const [gp, nonce] = await Promise.all([
      publicClient.getGasPrice(),
      publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
    ]);
    cachedGasPriceWei = gp;
    cachedGasPriceGwei = Number(gp) / 1e9;
    cachedNonce = nonce;
  } catch (err: any) {
    logThrottledWarn('exec_params', `Failed to refresh nonce/gas parameters: ${err.shortMessage || err.message}`);
  }
}
setInterval(refreshExecutionParams, 8000);

// ============================================================================
// 2. PROTOKOL VE DİNAMİK REZERV YAPILANDIRMASI (ARBITRUM MAINNET)
// ============================================================================
const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const;
const AAVE_DATA_PROVIDER_ADDRESS = '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654' as const;
const AAVE_ORACLE_ADDRESS = '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7' as const;

const rawBotContractAddr = (process.env.BOT_CONTRACT_ADDRESS || '').trim().toLowerCase();
if (!rawBotContractAddr || !isAddress(rawBotContractAddr)) {
  throw new Error('FATAL: Valid BOT_CONTRACT_ADDRESS is required in .env');
}
const OUR_BOT_CONTRACT_ADDRESS = getAddress(rawBotContractAddr);
let cachedEthPriceUSD = 2600;

// MİKRO BORÇ VE SIFIR ZARAR FİLTRELERİ:
const MIN_DEBT_USD = 50.0;
const MIN_STRIKE_DEBT_USD = 25.0;
const MIN_EXPECTED_NET_PROFIT_USD = 0.15;
// Arbitrum normalde 0.01 - 0.05 Gwei arasındadır; 1.5 Gwei üstü anormal ağ tıkanıklığında işlemi durdurur.
const MAX_GAS_PRICE_GWEI = 1.5;

// 3 KADEMELİ RADAR EŞİKLERİ:
const ULTRA_CRITICAL_HF_THRESHOLD = 1.045;
const CRITICAL_HF_THRESHOLD = 1.12;

interface ReserveAsset {
  name: string;
  address: `0x${string}`;
  decimals: number;
  liquidationBonusRatio: number; // Örn: 1.05 (%5 bonus)
  reserveId: number; // Aave V3.2/3.3 eMode collateralBitmap içindeki bit indeksi
}

interface EModeCategoryConfig {
  id: number;
  bonusRatio: number; // Örn: 1.01 (%1), 1.075 (%7.5), 1.10 (%10)
  collateralBitmap: bigint;
  label: string;
}

const eModeCategories = new Map<number, EModeCategoryConfig>();

// Başlangıç yedek rezerv listesi; bot açılışta getAllReservesTokens() ile Aave'deki tüm aktif varlıkları dinamik olarak üzerine ekler.
let AAVE_RESERVE_ASSETS: ReserveAsset[] = [
  { name: 'DAI',    address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, liquidationBonusRatio: 1.05,  reserveId: 0 },
  { name: 'LINK',   address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18, liquidationBonusRatio: 1.07,  reserveId: 1 },
  { name: 'USDC.e', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6,  liquidationBonusRatio: 1.05,  reserveId: 2 },
  { name: 'WBTC',   address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8,  liquidationBonusRatio: 1.065, reserveId: 3 },
  { name: 'WETH',   address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, liquidationBonusRatio: 1.05,  reserveId: 4 },
  { name: 'USDT',   address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6,  liquidationBonusRatio: 1.05,  reserveId: 5 },
  { name: 'AAVE',   address: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', decimals: 18, liquidationBonusRatio: 1.075, reserveId: 6 },
  { name: 'wstETH', address: '0x5979D7b546E38E414F7E9822514be443A4800529', decimals: 18, liquidationBonusRatio: 1.07,  reserveId: 8 },
  { name: 'rETH',   address: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8', decimals: 18, liquidationBonusRatio: 1.075, reserveId: 10 },
  { name: 'LUSD',   address: '0x93b346b6BC2548dA6A1E7d98E9a421B42541425b', decimals: 18, liquidationBonusRatio: 1.055, reserveId: 11 },
  { name: 'USDC',   address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6,  liquidationBonusRatio: 1.045, reserveId: 12 },
  { name: 'FRAX',   address: '0x17FC002b466eEc40DaE837fc4bE5c67993ddBd6F', decimals: 18, liquidationBonusRatio: 1.055, reserveId: 13 },
  { name: 'ARB',    address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, liquidationBonusRatio: 1.10,  reserveId: 14 },
  { name: 'weETH',  address: '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', decimals: 18, liquidationBonusRatio: 1.075, reserveId: 15 }
];

const getAllReservesTokensAbi = parseAbiItem(
  'function getAllReservesTokens() view returns ((string symbol, address tokenAddress)[])'
);
const getReserveConfigurationDataAbi = parseAbiItem(
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)'
);
const getEModeCategoryDataAbi = parseAbiItem(
  'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))'
);
const getEModeCategoryCollateralBitmapAbi = parseAbiItem(
  'function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)'
);
const getUserAccountDataAbi = parseAbiItem(
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
);
const getUserReserveDataAbi = parseAbiItem(
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)'
);
const getAssetsPricesAbi = parseAbiItem('function getAssetsPrices(address[] assets) view returns (uint256[])');
const getUserEModeAbi = parseAbiItem('function getUserEMode(address user) view returns (uint256)');
const borrowEventAbi = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)'
);
const liquidationCallEventAbi = parseAbiItem(
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)'
);
const botContractAbi = parseAbi([
  'function owner() external view returns (address)',
  'function profitRecipient() external view returns (address)',
  'function setProfitRecipient(address _newProfitRecipient) external',
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover) external',
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover, uint24 poolFee) external',
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover, uint24 poolFee, uint256 minProfit) external'
]);

// Aave ProtocolDataProvider üzerinden tüm aktif rezervleri, ondalık basamaklarını, gerçek tasfiye bonuslarını ve eMode kategori bitmap'lerini dinamik çeker.
async function syncDynamicReservesFromProtocol() {
  try {
    const rawTokens = (await publicClient.readContract({
      address: AAVE_DATA_PROVIDER_ADDRESS,
      abi: [getAllReservesTokensAbi],
      functionName: 'getAllReservesTokens'
    })) as readonly { symbol: string; tokenAddress: `0x${string}` }[];

    if (!rawTokens || rawTokens.length === 0) return;

    const eModeIds = Array.from({ length: 16 }, (_, idx) => idx + 1);
    const configContracts = [
      ...rawTokens.map(t => ({
        address: AAVE_DATA_PROVIDER_ADDRESS,
        abi: [getReserveConfigurationDataAbi] as const,
        functionName: 'getReserveConfigurationData' as const,
        args: [t.tokenAddress] as const
      })),
      ...eModeIds.map(id => ({
        address: AAVE_POOL_ADDRESS,
        abi: [getEModeCategoryDataAbi] as const,
        functionName: 'getEModeCategoryData' as const,
        args: [id] as const
      })),
      ...eModeIds.map(id => ({
        address: AAVE_POOL_ADDRESS,
        abi: [getEModeCategoryCollateralBitmapAbi] as const,
        functionName: 'getEModeCategoryCollateralBitmap' as const,
        args: [id] as const
      }))
    ];

    const configResults = await publicClient.multicall({
      contracts: configContracts,
      allowFailure: true
    });

    const discovered: ReserveAsset[] = [];
    for (let i = 0; i < rawTokens.length; i++) {
      const token = rawTokens[i];
      const cfg = configResults[i];
      if (cfg.status === 'success' && cfg.result) {
        const [decimals, , , liquidationBonus, , , , , isActive] = cfg.result as readonly [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          boolean,
          boolean,
          boolean,
          boolean,
          boolean
        ];
        if (!isActive) continue;
        // Aave'de liquidationBonus 10500 formatındadır (10000 = %100, 10500 = %5 bonus -> 1.05)
        const bonusNum = Number(liquidationBonus) / 10000;
        discovered.push({
          name: token.symbol,
          address: getAddress(token.tokenAddress),
          decimals: Number(decimals),
          liquidationBonusRatio: bonusNum >= 1.01 ? bonusNum : 1.05,
          reserveId: i
        });
      }
    }

    const dataOffset = rawTokens.length;
    const bitmapOffset = rawTokens.length + eModeIds.length;
    for (let j = 0; j < eModeIds.length; j++) {
      const id = eModeIds[j];
      const dataRes = configResults[dataOffset + j];
      const bitmapRes = configResults[bitmapOffset + j];
      if (dataRes?.status === 'success' && dataRes.result && bitmapRes?.status === 'success') {
        const catData = dataRes.result as {
          ltv: number;
          liquidationThreshold: number;
          liquidationBonus: number;
          priceSource: `0x${string}`;
          label: string;
        };
        const bitmap = BigInt(bitmapRes.result as bigint);
        if (catData.liquidationBonus > 10000 && bitmap > 0n) {
          eModeCategories.set(id, {
            id,
            bonusRatio: Number(catData.liquidationBonus) / 10000,
            collateralBitmap: bitmap,
            label: catData.label
          });
        }
      }
    }

    if (discovered.length >= 10) {
      AAVE_RESERVE_ASSETS = discovered;
      logInfo(
        `Synchronized ${discovered.length} active Aave V3 reserves and ${eModeCategories.size} eMode categories dynamically (${discovered.map(d => d.name).join(', ')}).`
      );
    }
  } catch (err: any) {
    logInfo(
      `Dynamic reserve sync fallback to default ${AAVE_RESERVE_ASSETS.length} reserves: ${err.shortMessage || err.message}`
    );
  }
}

// ============================================================================
// 3. KALICI HAFIZA, 3 KADEMELİ RADAR VE ÖN-HAZIRLIK ÖNBELLEĞİ (PRE-CACHE)
// ============================================================================
const DATA_DIR = path.join(__dirname, '../data');
const STORAGE_FILE = path.join(DATA_DIR, 'monitored_users.json');

const activeUsers = new Set<`0x${string}`>();
const ultraCriticalTargets = new Set<`0x${string}`>();
const criticalTargets = new Set<`0x${string}`>();
const cooldowns = new Map<string, number>();
const inFlightUsers = new Set<`0x${string}`>();
const warnTimestamps = new Map<string, number>();

interface LiquidationCandidate {
  debtAsset: `0x${string}`;
  debtName: string;
  debtAmount: bigint;
  debtDecimals: number;
  debtPriceUSD: number;
  debtUSD: number;
  collateralAsset: `0x${string}`;
  collateralName: string;
  collateralUSD: number;
  liquidationBonusRatio: number;
}

const targetStrikeCache = new Map<
  `0x${string}`,
  { candidates: LiquidationCandidate[]; updatedAt: number }
>();

function logInfo(message: string) {
  console.log(`[INFO] ${new Date().toISOString().split('T')[1].slice(0, -1)} - ${message}`);
}
function logAlert(message: string) {
  console.log(`[ALERT] ${new Date().toISOString().split('T')[1].slice(0, -1)} - ${message}`);
}
function logThrottledWarn(key: string, message: string, intervalMs = 60000) {
  const now = Date.now();
  const last = warnTimestamps.get(key) || 0;
  if (now - last >= intervalMs) {
    warnTimestamps.set(key, now);
    console.warn(`[WARN] ${new Date().toISOString().split('T')[1].slice(0, -1)} - ${message}`);
  }
}

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
async function getLiquidationCandidates(
  userAddress: `0x${string}`
): Promise<LiquidationCandidate[]> {
  try {
    const reservesSnapshot = AAVE_RESERVE_ASSETS;
    const allAssetAddresses = reservesSnapshot.map(a => a.address);

    const contracts = [
      ...reservesSnapshot.map(asset => ({
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
      },
      {
        address: AAVE_POOL_ADDRESS,
        abi: [getUserEModeAbi] as const,
        functionName: 'getUserEMode' as const,
        args: [userAddress] as const
      }
    ];

    let pricesRaw: bigint[] | null = null;
    let userEMode = 0n;
    let results: any[] = [];

    for (let attempt = 0; attempt < readClients.length; attempt++) {
      const client = getNextReadClient();
      try {
        results = await client.multicall({ contracts, allowFailure: true });
        const priceResult = results[results.length - 2];
        const eModeResult = results[results.length - 1];
        if (eModeResult?.status === 'success' && typeof eModeResult.result === 'bigint') {
          userEMode = eModeResult.result;
        }
        const candidatePrices = (priceResult?.status === 'success' ? priceResult.result : null) as
          | bigint[]
          | null;
        if (candidatePrices && candidatePrices.length === reservesSnapshot.length) {
          pricesRaw = candidatePrices;
          break;
        }
      } catch {
        // Sıradaki RPC ile tekrar dene
      }
    }

    // ORACLE KORUMASI: Tüm RPC'lerde fiyat verisi alınamadıysa yanlış varsayılan (1.0$) kullanmak yerine değerlendirmeyi durdur.
    if (!pricesRaw || pricesRaw.length !== reservesSnapshot.length) {
      logThrottledWarn('oracle_null', `Oracle price array incomplete for ${userAddress}; skipping evaluation.`);
      return [];
    }

    const userDebts: { asset: ReserveAsset; amount: bigint; priceUSD: number; usd: number }[] = [];
    const userCollaterals: { asset: ReserveAsset; usd: number }[] = [];

    for (let i = 0; i < reservesSnapshot.length; i++) {
      const asset = reservesSnapshot[i];
      const res = results[i];
      if (res.status === 'success' && res.result) {
        const [
          currentATokenBalance,
          currentStableDebt,
          currentVariableDebt,
          ,
          ,
          ,
          ,
          ,
          usageAsCollateralEnabled
        ] = res.result as readonly [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          number,
          boolean
        ];

        const priceUSD = Number(pricesRaw[i]) / 1e8;
        if (priceUSD <= 0) continue;
        if (asset.address.toLowerCase() === '0x82af49447d8a07e3bd95bd0d56f35241523fbab1') {
          cachedEthPriceUSD = priceUSD;
        }

        const totalAssetDebt = currentVariableDebt + currentStableDebt;
        if (totalAssetDebt > 0n) {
          const debtTokenAmount = Number(formatUnits(totalAssetDebt, asset.decimals));
          const debtValueUSD = debtTokenAmount * priceUSD;
          if (debtValueUSD >= MIN_STRIKE_DEBT_USD) {
            userDebts.push({ asset, amount: totalAssetDebt, priceUSD, usd: debtValueUSD });
          }
        }

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

    const eModeCat = userEMode > 0n ? eModeCategories.get(Number(userEMode)) : undefined;

    const candidates: LiquidationCandidate[] = [];
    for (const d of userDebts) {
      for (const c of userCollaterals) {
        if (d.asset.address.toLowerCase() !== c.asset.address.toLowerCase()) {
          // Aave v3.3 kuralı: eMode bonusu yalnızca o eMode kategorisinin collateralBitmap'ine dahil olan teminatlarda geçerlidir
          const isCollateralInEMode =
            eModeCat !== undefined &&
            c.asset.reserveId >= 0 &&
            ((eModeCat.collateralBitmap >> BigInt(c.asset.reserveId)) & 1n) === 1n;
          const effectiveBonusRatio = isCollateralInEMode
            ? eModeCat.bonusRatio
            : c.asset.liquidationBonusRatio;

          candidates.push({
            debtAsset: d.asset.address,
            debtName: d.asset.name,
            debtAmount: d.amount,
            debtDecimals: d.asset.decimals,
            debtPriceUSD: d.priceUSD,
            debtUSD: d.usd,
            collateralAsset: c.asset.address,
            collateralName: c.asset.name,
            collateralUSD: c.usd,
            liquidationBonusRatio: effectiveBonusRatio
          });
        }
      }
    }

    // Beklenen brüt tasfiye primine (kapatılabilir USD * bonus yüzdesi) göre en kârlı çiftleri sırala
    candidates.sort((a, b) => {
      const covA = Math.min(a.debtUSD, a.collateralUSD / a.liquidationBonusRatio);
      const covB = Math.min(b.debtUSD, b.collateralUSD / b.liquidationBonusRatio);
      const bonusA = covA * (a.liquidationBonusRatio - 1.0);
      const bonusB = covB * (b.liquidationBonusRatio - 1.0);
      return bonusB - bonusA;
    });

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
// 5. PARALEL SİMÜLASYONLU VE DOĞRULAMALI KESKİN NİŞANCI VURUŞU
// ============================================================================
async function executeLiquidationStrike(
  userAddress: `0x${string}`,
  healthFactor: number,
  totalDebtUSD: number
) {
  const now = Date.now();
  cooldowns.set(userAddress, now + 2500);

  logAlert(
    `LIQUIDATION TARGET IDENTIFIED | Target: ${userAddress} | HF: ${healthFactor.toFixed(4)} | Total Debt: $${totalDebtUSD.toFixed(2)}`
  );

  if (cachedGasPriceGwei > MAX_GAS_PRICE_GWEI) {
    logInfo(
      `Network gas price (${cachedGasPriceGwei.toFixed(2)} Gwei) exceeds safety cap (${MAX_GAS_PRICE_GWEI} Gwei). Aborting strike.`
    );
    return;
  }

  const cached = targetStrikeCache.get(userAddress);
  const candidates =
    cached && now - cached.updatedAt < 60000
      ? cached.candidates
      : await getLiquidationCandidates(userAddress);

  if (candidates.length === 0) {
    logInfo(`No liquidatable distinct debt/collateral pair found for ${userAddress}.`);
    cooldowns.set(userAddress, now + 30000);
    return;
  }

  interface StrikePlan {
    target: LiquidationCandidate;
    amount: bigint;
    minProfitRaw: bigint;
    usd: number;
    expectedNetBonusUSD: number;
    label: string;
  }

  const plans: StrikePlan[] = [];
  // Tahmini Arbitrum gas maliyeti (~900,000 gas * güncel gas fiyatı * canlı Oracle WETH fiyatı)
  const estimatedGasCostUSD = Math.max(0.02, cachedGasPriceGwei * 0.0009 * cachedEthPriceUSD);

  for (const target of candidates) {
    // Aave v3.3'te HF <= 0.95 veya borç/teminat < $2,000 olduğunda %100 kapatma uygulanır.
    // Bloklar arası faiz birikimi veya rayMul yuvarlaması yüzünden birkaç wei borç kalıp MustNotLeaveDust revert'ü oluşmaması için
    // tam kapatmada +%0.1 (1001n/1000n) tampon eklenir; Aave fazlalığı keser ve sözleşmedeki unspentAsset bunu otomatik dengeler.
    const canClose100Percent =
      healthFactor <= 0.95 || target.debtUSD < 2000 || target.collateralUSD < 2000;
    let fullDebtToCover = canClose100Percent
      ? (target.debtAmount * 1001n) / 1000n
      : target.debtAmount / 2n;
    let fullCoverUSD = canClose100Percent ? target.debtUSD : target.debtUSD / 2;

    const maxCoverableByCollateralUSD = target.collateralUSD / target.liquidationBonusRatio;

    if (fullCoverUSD > maxCoverableByCollateralUSD) {
      const scaleRatio = BigInt(Math.floor((maxCoverableByCollateralUSD / target.debtUSD) * 10010));
      fullDebtToCover = (target.debtAmount * scaleRatio) / 10000n;
      fullCoverUSD = maxCoverableByCollateralUSD;
    }

    if (fullCoverUSD < MIN_STRIKE_DEBT_USD || fullDebtToCover === 0n) {
      continue;
    }

    // Tahmini net kâr kontrolü: Brüt Bonus - (%0.05 FlashLoan + %0.30 Swap) - Tahmini Gas
    const grossBonusUSD = fullCoverUSD * (target.liquidationBonusRatio - 1.0);
    const protocolAndSwapFeeUSD = fullCoverUSD * 0.0035;
    const expectedNetBonusUSD = grossBonusUSD - protocolAndSwapFeeUSD - estimatedGasCostUSD;

    if (expectedNetBonusUSD < MIN_EXPECTED_NET_PROFIT_USD) {
      continue;
    }

    // Sözleşme içi minProfit garantisi: En az tahmini gas maliyeti + minimum net kâr ($0.15) tutarını karşılayacak borç tokenı miktarı
    const minProfitUSD = Math.max(0.05, estimatedGasCostUSD + MIN_EXPECTED_NET_PROFIT_USD);
    const minProfitTokens =
      target.debtPriceUSD > 0 ? minProfitUSD / target.debtPriceUSD : 0;
    const minProfitRaw = BigInt(
      Math.max(1, Math.floor(minProfitTokens * Math.pow(10, Math.min(target.debtDecimals, 8))))
    ) * (target.debtDecimals > 8 ? 10n ** BigInt(target.debtDecimals - 8) : 1n);

    plans.push({
      target,
      amount: fullDebtToCover,
      minProfitRaw,
      usd: fullCoverUSD,
      expectedNetBonusUSD,
      label: 'FULL'
    });

    // Aave v3.3 toz kalıntı (dust) kuralına takılmamak için sadece kalan borcun >$5,000 olduğu büyük pozisyonlarda %50 kısmi yedek plan ekle
    if (fullCoverUSD >= 10000 && target.debtUSD - fullCoverUSD / 2 >= 5000) {
      plans.push({
        target,
        amount: fullDebtToCover / 2n,
        minProfitRaw,
        usd: fullCoverUSD / 2,
        expectedNetBonusUSD: expectedNetBonusUSD / 2,
        label: 'PARTIAL-50%'
      });
    }
  }

  if (plans.length === 0) return;

  // PARALEL ÖN SİMÜLASYON (6 parametreli: debtAsset, collateralAsset, user, amount, poolFee=500, minProfit)
  const simResults = await Promise.allSettled(
    plans.map(plan =>
      publicClient.simulateContract({
        address: OUR_BOT_CONTRACT_ADDRESS,
        abi: botContractAbi,
        functionName: 'triggerLiquidation',
        args: [
          plan.target.debtAsset,
          plan.target.collateralAsset,
          userAddress,
          plan.amount,
          500,
          plan.minProfitRaw
        ],
        account
      })
    )
  );

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const sim = simResults[i];

    if (sim.status === 'fulfilled') {
      logAlert(
        `SIMULATION PASSED [${plan.label}]! BROADCASTING TO SEQUENCER (${plan.target.collateralName} -> ${plan.target.debtName} | Cover: ~$${plan.usd.toFixed(2)} | Est. Net: +$${plan.expectedNetBonusUSD.toFixed(2)})...`
      );

      try {
        const simulatedGas = sim.value.request.gas;
        const safeGasLimit = simulatedGas ? (simulatedGas * 130n) / 100n : 1200000n;

        const txOptions: any = {
          ...sim.value.request,
          gas: safeGasLimit,
          maxFeePerGas: cachedGasPriceWei * 2n + 10000000n,
          maxPriorityFeePerGas: 0n
        };

        // NONCE ÇAKIŞMA KORUMASI: Gönderim öncesinde senkron olarak nonce ayır; hata olursa catch bloğunda ağdan geri senkronize edilir
        if (cachedNonce !== undefined) {
          txOptions.nonce = cachedNonce;
          cachedNonce++;
        }

        const txHash = await Promise.any(
          broadcastWalletClients.map(wc => wc.writeContract(txOptions))
        );

        logAlert(`TRANSACTION BROADCASTED | Waiting for on-chain receipt | TxHash: ${txHash}`);

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: 15000
        });

        if (receipt.status === 'success') {
          logAlert(
            `STRIKE EXECUTED SUCCESSFULLY! Confirmed in Block ${receipt.blockNumber} | TxHash: ${txHash}`
          );
          cooldowns.set(userAddress, Date.now() + 60000);
        } else {
          logInfo(`Transaction reverted on-chain in Block ${receipt.blockNumber} | TxHash: ${txHash}`);
        }

        refreshExecutionParams();
        return;
      } catch (sendErr: any) {
        logInfo(`Broadcast/Confirmation error: ${sendErr.shortMessage || sendErr.message}`);
        await refreshExecutionParams();
      }
    } else {
      const errorText =
        sim.reason?.shortMessage || sim.reason?.message?.split('\n')[0] || 'Reverted';
      logInfo(
        `Simulation reverted (${plan.target.collateralName} -> ${plan.target.debtName} [${plan.label}]): ${errorText}`
      );
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
  } else if (
    healthFactor >= 1.0 &&
    healthFactor < ULTRA_CRITICAL_HF_THRESHOLD &&
    totalDebtUSD >= MIN_DEBT_USD
  ) {
    criticalTargets.delete(userAddress);
    if (!ultraCriticalTargets.has(userAddress)) {
      ultraCriticalTargets.add(userAddress);
      logAlert(
        `ULTRA-CRITICAL TARGET LOCKED (250ms Poll) | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`
      );
    }
    const cached = targetStrikeCache.get(userAddress);
    if (!cached || now - cached.updatedAt > 45000) {
      getLiquidationCandidates(userAddress).catch(() => {});
    }
  } else if (
    healthFactor >= ULTRA_CRITICAL_HF_THRESHOLD &&
    healthFactor <= CRITICAL_HF_THRESHOLD &&
    totalDebtUSD >= MIN_DEBT_USD
  ) {
    ultraCriticalTargets.delete(userAddress);
    if (!criticalTargets.has(userAddress)) {
      criticalTargets.add(userAddress);
      logAlert(
        `HIGH RISK BORROWER PROMOTED TO SNIPER RADAR | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`
      );
    }
  } else {
    ultraCriticalTargets.delete(userAddress);
    criticalTargets.delete(userAddress);
    targetStrikeCache.delete(userAddress);
    if (totalDebtUSD === 0) {
      activeUsers.delete(userAddress);
      scheduleSaveUsers();
    }
  }
}

async function checkUsersBatch(addresses: `0x${string}`[], useFastPool = false) {
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

    const client = useFastPool ? getNextReadClient() : publicClient;
    const results = await client.multicall({ contracts, allowFailure: true });

    for (let i = 0; i < eligibleAddresses.length; i++) {
      const res = results[i];
      if (res.status === 'success' && res.result) {
        await processUserAccountData(
          eligibleAddresses[i],
          res.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint]
        );
      }
    }
  } catch (err: any) {
    logThrottledWarn('batch_multicall', `Temporary RPC error in checkUsersBatch: ${err.shortMessage || err.message}`);
  }
}

// ============================================================================
// 7. 3 KADEMELİ KESKİN NİŞANCI VE RADAR DÖNGÜLERİ (250ms / 2.5s / 15s)
// ============================================================================
async function ultraCriticalSniperLoop() {
  if (ultraCriticalTargets.size > 0) {
    const targets = Array.from(ultraCriticalTargets);
    await checkUsersBatch(targets, true);
  }
  setTimeout(ultraCriticalSniperLoop, 250);
}

async function criticalSniperLoop() {
  if (criticalTargets.size > 0) {
    const targets = Array.from(criticalTargets);
    await checkUsersBatch(targets, true);
  }
  setTimeout(criticalSniperLoop, 2500);
}

const MULTICALL_BATCH_SIZE = 35;
const BATCH_DELAY_MS = 250;

async function generalRadarLoop() {
  if (activeUsers.size > 0) {
    const nonCriticalUsers = Array.from(activeUsers).filter(
      u => !ultraCriticalTargets.has(u) && !criticalTargets.has(u)
    );

    logInfo(
      `Executing sweep across ${activeUsers.size} monitored addresses (Ultra-Critical [250ms]: ${ultraCriticalTargets.size} | Critical [2.5s]: ${criticalTargets.size})...`
    );

    for (let i = 0; i < nonCriticalUsers.length; i += MULTICALL_BATCH_SIZE) {
      const chunk = nonCriticalUsers.slice(i, i + MULTICALL_BATCH_SIZE);
      await checkUsersBatch(chunk, false);
      if (i + MULTICALL_BATCH_SIZE < nonCriticalUsers.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
  }

  setTimeout(generalRadarLoop, 15000);
}

// ============================================================================
// 8. GEÇMİŞ BORÇLU DERİN TARAYICISI (onBehalfOf DESTEKLİ) VE ANA MOTOR
// ============================================================================
async function syncRecentBorrowers(currentBlock: bigint) {
  // Arka planda son 1,200,000 bloğu (~3.5 gün) parça parça tarayarak hem onBehalfOf hem user adreslerini radara katar
  const LOOKBACK = 1200000n;
  const CHUNK = 30000n;
  let added = 0;

  for (let to = currentBlock; to > currentBlock - LOOKBACK && to > 0n; to -= CHUNK) {
    const from = to - CHUNK > 0n ? to - CHUNK : 1n;
    for (const client of readClients) {
      try {
        const logs = await client.getLogs({
          address: AAVE_POOL_ADDRESS,
          event: borrowEventAbi,
          fromBlock: from,
          toBlock: to
        });
        for (const log of logs) {
          // KRİTİK DÜZELTME: Borcun gerçek sahibi onBehalfOf adresidir (kaldıraç/router kontratlarında user aracıdır)
          const borrower = log.args.onBehalfOf || log.args.user;
          if (borrower && isAddress(borrower)) {
            const checksummed = getAddress(borrower);
            if (!activeUsers.has(checksummed)) {
              activeUsers.add(checksummed);
              added++;
            }
          }
        }
        break;
      } catch {
        // Sıradaki RPC'yi dene
      }
    }
    if (added > 0 && added % 100 === 0) {
      scheduleSaveUsers();
    }
    await new Promise(r => setTimeout(r, 400));
  }

  if (added > 0) {
    logInfo(
      `Synchronized ${added} historical borrowers (via onBehalfOf) from recent blocks. Total monitored: ${activeUsers.size}`
    );
    scheduleSaveUsers();
  }
}

async function getBlockNumberWithRetry(): Promise<bigint> {
  while (true) {
    try {
      return await publicClient.getBlockNumber();
    } catch (err: any) {
      logInfo(
        `RPC busy on startup (${err.shortMessage || 'Rate limit'}). Retrying in 5 seconds...`
      );
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function main() {
  console.log('==================================================');
  console.log('[SYSTEM] HIGH-FREQUENCY LIQUIDATION SNIPER ENGINE ONLINE');
  console.log('==================================================');

  loadMonitoredUsers();
  await refreshExecutionParams();

  try {
    const currentRecipient = (await publicClient.readContract({
      address: OUR_BOT_CONTRACT_ADDRESS,
      abi: botContractAbi,
      functionName: 'profitRecipient'
    })) as `0x${string}`;
    const desiredRecipientRaw = (process.env.PROFIT_RECIPIENT_ADDRESS || '').trim().toLowerCase();
    if (desiredRecipientRaw && isAddress(desiredRecipientRaw)) {
      const desiredRecipient = getAddress(desiredRecipientRaw);
      if (currentRecipient.toLowerCase() !== desiredRecipient.toLowerCase()) {
        logInfo(`Updating on-chain profitRecipient from ${currentRecipient} to ${desiredRecipient}...`);
        const txHash = await broadcastWalletClients[0].writeContract({
          address: OUR_BOT_CONTRACT_ADDRESS,
          abi: botContractAbi,
          functionName: 'setProfitRecipient',
          args: [desiredRecipient],
          account,
          chain: chainToUse
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        await refreshExecutionParams();
        logInfo(`Updated on-chain profitRecipient to ${desiredRecipient} (Tx: ${txHash})`);
      } else {
        logInfo(`Verified Contract Security | Hot Executor: ${account.address} | Cold Profit Vault: ${currentRecipient}`);
      }
    } else {
      logInfo(`Verified Contract Roles | Executor: ${account.address} | Profit Vault: ${currentRecipient}`);
    }
  } catch (err: any) {
    logThrottledWarn('profit_recipient_check', `Could not verify profitRecipient on startup: ${err.shortMessage || err.message}`);
  }

  const currentBlock = await getBlockNumberWithRetry();
  logInfo(`Connected to Arbitrum Network. Current Block: ${currentBlock}`);

  // Aave V3 üzerindeki tüm aktif rezervleri ve gerçek tasfiye bonuslarını dinamik çek (ve her 30 dakikada bir yenile)
  await syncDynamicReservesFromProtocol();
  setInterval(syncDynamicReservesFromProtocol, 30 * 60 * 1000);

  // Arka planda geçmiş bloklardaki borçluları (onBehalfOf) senkronize et
  syncRecentBorrowers(currentBlock);

  // Canlı ağda gerçekleşen yeni Borrow ve LiquidationCall olaylarını üst üste binmeyen (non-overlapping) ardışık getLogs döngüsüyle izle
  let lastEventBlock = currentBlock;
  async function pollLiveEventsLoop() {
    let lastErr: any = null;
    try {
      for (const client of readClients) {
        try {
          const latestBlock = await client.getBlockNumber();
          if (latestBlock <= lastEventBlock) {
            lastErr = null;
            break;
          }

          // Bağlantı kesintisinde hiçbir bloğu atlamamak için ileriye doğru en fazla 2000 blokluk dilimlerle ilerle
          const fromBlock = lastEventBlock + 1n;
          const toBlock = fromBlock + 2000n < latestBlock ? fromBlock + 2000n : latestBlock;

          const [borrowLogs, liqLogs] = await Promise.all([
            client.getLogs({
              address: AAVE_POOL_ADDRESS,
              event: borrowEventAbi,
              fromBlock,
              toBlock
            }),
            client.getLogs({
              address: AAVE_POOL_ADDRESS,
              event: liquidationCallEventAbi,
              fromBlock,
              toBlock
            })
          ]);

          lastEventBlock = toBlock;

          let newUsersAdded = 0;
          for (const log of borrowLogs) {
            const borrower = log.args?.onBehalfOf || log.args?.user;
            if (borrower && isAddress(borrower)) {
              const checksummed = getAddress(borrower);
              if (!activeUsers.has(checksummed)) {
                activeUsers.add(checksummed);
                newUsersAdded++;
                logInfo(`New borrower detected on-chain (onBehalfOf): ${checksummed}`);
                checkUsersBatch([checksummed], true);
              }
            }
          }
          if (newUsersAdded > 0) {
            scheduleSaveUsers();
          }

          for (const log of liqLogs) {
            const user = log.args?.user;
            const liquidator = log.args?.liquidator;
            if (user && isAddress(user)) {
              const checksummed = getAddress(user);
              const inRadar = activeUsers.has(checksummed);
              logAlert(
                `ON-CHAIN LIQUIDATION OBSERVED | User: ${checksummed} | In Our Radar: ${inRadar ? 'YES' : 'NO'} | Liquidator: ${liquidator}`
              );
              if (!inRadar) {
                activeUsers.add(checksummed);
                scheduleSaveUsers();
              }
              checkUsersBatch([checksummed], true);
            }
          }
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
        }
      }
      if (lastErr) {
        logThrottledWarn(
          'poll_events',
          `Event polling failed across all RPCs: ${lastErr.shortMessage || lastErr.message}`
        );
      }
    } finally {
      setTimeout(pollLiveEventsLoop, 10000);
    }
  }
  pollLiveEventsLoop();

  logInfo(
    `Starting 3-tier Multi-RPC radar loops (250ms / 2.5s / 15s). Monitoring ${activeUsers.size} addresses across ${AAVE_RESERVE_ASSETS.length} reserves.`
  );
  ultraCriticalSniperLoop();
  criticalSniperLoop();
  generalRadarLoop();
}

main().catch(err => console.error(`[FATAL ERROR] ${err.message}`));
