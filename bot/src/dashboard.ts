import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import * as dotenv from 'dotenv';
import {
  createPublicClient,
  http as viemHttp,
  parseAbiItem,
  isAddress,
  getAddress,
  formatUnits
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

// .env dosyasini bot klasorunden yukle
dotenv.config({ path: path.join(__dirname, '../.env') });

// ============================================================================
// 1. SABITLER VE RPC ISTEMCILERI
// ============================================================================
const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const HOST = '127.0.0.1';

const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const;
const AAVE_DATA_PROVIDER_ADDRESS = '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654' as const;
const AAVE_ORACLE_ADDRESS = '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7' as const;

const OUR_BOT_CONTRACT_ADDRESS = (
  process.env.BOT_CONTRACT_ADDRESS || '0x1cA5f9cAcbEe5533E03fd643E2d4BC89aF667c6c'
) as `0x${string}`;

let walletAddress = 'Tanımsız';
if (process.env.PRIVATE_KEY) {
  try {
    const pk = process.env.PRIVATE_KEY.startsWith('0x')
      ? (process.env.PRIVATE_KEY as `0x${string}`)
      : (`0x${process.env.PRIVATE_KEY}` as `0x${string}`);
    walletAddress = privateKeyToAccount(pk).address;
  } catch {
    walletAddress = 'Geçersiz Anahtar';
  }
}

const primaryRpcUrl = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';

// Okuma ve Multicall icin birincil istemci
const publicClient = createPublicClient({
  chain: arbitrum,
  transport: viemHttp(primaryRpcUrl, { timeout: 15000 })
});

// Genis blok aralikli getLogs taramalari icin yedek halka acik RPC istemcileri
const logClients = [
  createPublicClient({
    chain: arbitrum,
    transport: viemHttp('https://arbitrum-one-rpc.publicnode.com', { timeout: 20000 })
  }),
  createPublicClient({
    chain: arbitrum,
    transport: viemHttp('https://arb1.arbitrum.io/rpc', { timeout: 20000 })
  }),
  publicClient
];

// ============================================================================
// 2. REZERV VARLIKLARI VE ABI TANIMLARI
// ============================================================================
interface TokenMeta {
  symbol: string;
  decimals: number;
  priceUSD: number;
  isSupportedByBot: boolean;
}

const KNOWN_RESERVES: { symbol: string; address: `0x${string}`; decimals: number }[] = [
  { symbol: 'USDC',   address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  { symbol: 'USDC.e', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6 },
  { symbol: 'USDT',   address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  { symbol: 'DAI',    address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
  { symbol: 'WETH',   address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  { symbol: 'WBTC',   address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
  { symbol: 'wstETH', address: '0x5979D7b546E38E414F7E9822514be443A4800529', decimals: 18 },
  { symbol: 'weETH',  address: '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', decimals: 18 },
  { symbol: 'rETH',   address: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8', decimals: 18 },
  { symbol: 'ARB',    address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  { symbol: 'LINK',   address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18 },
  { symbol: 'AAVE',   address: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', decimals: 18 },
  { symbol: 'FRAX',   address: '0x17FC002b466eEc40DaE837fc4bE5c67993ddBd6F', decimals: 18 },
  { symbol: 'LUSD',   address: '0x93b346b6BC2548dA6A1E7d98E9a421B42541425b', decimals: 18 }
];

const tokenMetaCache = new Map<string, TokenMeta>();
for (const r of KNOWN_RESERVES) {
  tokenMetaCache.set(r.address.toLowerCase(), {
    symbol: r.symbol,
    decimals: r.decimals,
    priceUSD: 1.0,
    isSupportedByBot: true
  });
}

const getUserAccountDataAbi = parseAbiItem(
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
);
const getUserReserveDataAbi = parseAbiItem(
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)'
);
const getAssetsPricesAbi = parseAbiItem('function getAssetsPrices(address[] assets) view returns (uint256[])');
const erc20SymbolAbi = parseAbiItem('function symbol() view returns (string)');
const erc20DecimalsAbi = parseAbiItem('function decimals() view returns (uint8)');
const borrowEventAbi = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)'
);
const liquidationCallEventAbi = parseAbiItem(
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)'
);

// ============================================================================
// 3. YEREL DOSYA VE BELLEK DURUMU
// ============================================================================
const DATA_DIR = path.join(__dirname, '../data');
const MONITORED_USERS_FILE = path.join(DATA_DIR, 'monitored_users.json');
const LIQ_CACHE_FILE = path.join(DATA_DIR, 'liquidation_history_cache.json');
const HTML_FILE = path.join(__dirname, 'dashboard.html');

// Botun ilk acildigi andaki orijinal radar listesi ("Radarda miydi?" kontrolu icin)
const initialRadarSet = new Set<string>();
const monitoredUsersSet = new Set<`0x${string}`>();

interface BorrowerRecord {
  address: `0x${string}`;
  totalCollateralUSD: number;
  totalDebtUSD: number;
  availableBorrowsUSD: number;
  liquidationThresholdPct: number;
  ltvPct: number;
  healthFactor: number;
  updatedAt: number;
}

interface LiquidationRecord {
  txHash: string;
  blockNumber: number;
  timestampMs: number;
  user: `0x${string}`;
  liquidator: `0x${string}`;
  collateralAsset: `0x${string}`;
  collateralSymbol: string;
  collateralAmountRaw: string;
  collateralAmountFormatted: number;
  collateralUSD: number;
  debtAsset: `0x${string}`;
  debtSymbol: string;
  debtAmountRaw: string;
  debtAmountFormatted: number;
  debtUSD: number;
  bonusUSD: number;
  wasInRadar: boolean;
  isRealOpportunity: boolean;
  botStatusCode: 'OUR_BOT' | 'SKIPPED_DUST' | 'SKIPPED_SAME_TOKEN' | 'UNSUPPORTED_TOKEN' | 'NOT_IN_RADAR' | 'COMPETITOR_FAST';
  botReasonText: string;
}

interface LiveBorrowRecord {
  txHash: string;
  blockNumber: number;
  timestampMs: number;
  user: `0x${string}`;
  reserve: `0x${string}`;
  assetSymbol: string;
  amountFormatted: number;
  amountUSD: number;
  interestRateMode: number;
  userTotalDebtUSD: number;
  userHealthFactor: number;
}

const borrowersMap = new Map<string, BorrowerRecord>();
const liquidationsMap = new Map<string, LiquidationRecord>();
const liveBorrowsMap = new Map<string, LiveBorrowRecord>();

let currentBlockNum = 0n;
let currentBlockTimestampSec = Math.floor(Date.now() / 1000);
let ethBalanceFormatted = 0;
let ethPriceUSD = 2500;
let lastUpdatedMs = Date.now();

let scanProgress = {
  liqPct: 0,
  borrowerPct: 0,
  statusText: 'Sistem başlatılıyor...'
};

let isScanningLiquidations = false;
let isScanningBorrowers = false;

// ============================================================================
// 4. YARDIMCI FONKSIYONLAR VE KALICI DEPOLAMA
// ============================================================================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadMonitoredUsersFromDisk() {
  ensureDataDir();
  if (!fs.existsSync(MONITORED_USERS_FILE)) {
    fs.writeFileSync(MONITORED_USERS_FILE, JSON.stringify([], null, 2), 'utf-8');
    return;
  }
  try {
    const raw = fs.readFileSync(MONITORED_USERS_FILE, 'utf-8');
    const arr: string[] = JSON.parse(raw);
    for (const a of arr) {
      if (isAddress(a)) {
        const checksummed = getAddress(a);
        monitoredUsersSet.add(checksummed);
        initialRadarSet.add(checksummed.toLowerCase());
      }
    }
    console.log(`[INFO] Loaded ${monitoredUsersSet.size} monitored addresses from disk.`);
  } catch (err: any) {
    console.error(`[ERROR] Could not read monitored_users.json: ${err.message}`);
  }
}

let saveUsersTimer: NodeJS.Timeout | null = null;
function scheduleSaveMonitoredUsers() {
  if (saveUsersTimer) clearTimeout(saveUsersTimer);
  saveUsersTimer = setTimeout(() => {
    try {
      ensureDataDir();
      fs.writeFileSync(
        MONITORED_USERS_FILE,
        JSON.stringify(Array.from(monitoredUsersSet), null, 2),
        'utf-8'
      );
    } catch {
      // Yazma hatasini sessizce gec
    }
  }, 1500);
}

let cachedHighestBlock = 0n;
let cachedFullScanDone = false;

function loadLiquidationCacheFromDisk() {
  ensureDataDir();
  if (!fs.existsSync(LIQ_CACHE_FILE)) return;
  try {
    const raw = fs.readFileSync(LIQ_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.highestBlock) cachedHighestBlock = BigInt(parsed.highestBlock);
    if (parsed.fullScanDone) cachedFullScanDone = Boolean(parsed.fullScanDone);
    if (Array.isArray(parsed.records)) {
      for (const rec of parsed.records) {
        if (rec && rec.txHash) {
          rec.botReasonText = formatBotReason(
            rec.botStatusCode,
            Number(rec.debtUSD || 0),
            String(rec.debtSymbol || ''),
            String(rec.collateralSymbol || ''),
            String(rec.liquidator || '')
          );
          liquidationsMap.set(`${rec.txHash}-${rec.user}`, rec);
        }
      }
    }
  } catch {
    // Onbellek okunamazsa sifirdan taranir
  }
}

function saveLiquidationCacheToDisk(highestBlock?: bigint, fullScanDone?: boolean) {
  try {
    ensureDataDir();
    if (highestBlock !== undefined && highestBlock > cachedHighestBlock) {
      cachedHighestBlock = highestBlock;
    }
    if (fullScanDone !== undefined) {
      cachedFullScanDone = fullScanDone;
    }
    const records = Array.from(liquidationsMap.values()).sort((a, b) => b.blockNumber - a.blockNumber);
    fs.writeFileSync(
      LIQ_CACHE_FILE,
      JSON.stringify(
        {
          updatedAt: Date.now(),
          highestBlock: cachedHighestBlock.toString(),
          fullScanDone: cachedFullScanDone,
          records
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch {
    // Yazma hatasini sessizce gec
  }
}

// ============================================================================
// 5. FIYAT KAHINI (ORACLE) VE TOKEN METADATA COZUCU
// ============================================================================
async function refreshKnownPricesAndMeta(extraAddresses: `0x${string}`[] = []) {
  try {
    const unknownAddrs: `0x${string}`[] = [];
    for (const addr of extraAddresses) {
      const key = addr.toLowerCase();
      if (!tokenMetaCache.has(key)) {
        unknownAddrs.push(getAddress(addr));
      }
    }

    if (unknownAddrs.length > 0) {
      const metaContracts = unknownAddrs.flatMap(addr => [
        { address: addr, abi: [erc20SymbolAbi] as const, functionName: 'symbol' as const },
        { address: addr, abi: [erc20DecimalsAbi] as const, functionName: 'decimals' as const }
      ]);
      const metaRes = await publicClient.multicall({ contracts: metaContracts, allowFailure: true });
      for (let i = 0; i < unknownAddrs.length; i++) {
        const symRes = metaRes[i * 2];
        const decRes = metaRes[i * 2 + 1];
        const symbol = symRes.status === 'success' ? String(symRes.result) : unknownAddrs[i].slice(0, 6);
        const decimals = decRes.status === 'success' ? Number(decRes.result) : 18;
        tokenMetaCache.set(unknownAddrs[i].toLowerCase(), {
          symbol,
          decimals,
          priceUSD: 0,
          isSupportedByBot: true
        });
      }
    }

    const allTokenAddresses = Array.from(tokenMetaCache.keys()).map(k => getAddress(k));
    if (allTokenAddresses.length === 0) return;

    const pricesRaw = (await publicClient.readContract({
      address: AAVE_ORACLE_ADDRESS,
      abi: [getAssetsPricesAbi],
      functionName: 'getAssetsPrices',
      args: [allTokenAddresses]
    })) as bigint[];

    for (let i = 0; i < allTokenAddresses.length; i++) {
      const key = allTokenAddresses[i].toLowerCase();
      const meta = tokenMetaCache.get(key);
      if (meta && pricesRaw[i] !== undefined) {
        meta.priceUSD = Number(pricesRaw[i]) / 1e8;
        if (meta.symbol === 'WETH' && meta.priceUSD > 0) {
          ethPriceUSD = meta.priceUSD;
        }
      }
    }
  } catch (err: any) {
    console.error(`[WARN] Token price refresh warning: ${err.shortMessage || err.message}`);
  }
}

// ============================================================================
// 6. DAYANIKLI LOG SORGULAMA (RESILIENT GETLOGS)
// ============================================================================
async function getLogsResilient(
  eventAbi: any,
  fromBlock: bigint,
  toBlock: bigint
): Promise<any[]> {
  for (const client of logClients) {
    try {
      const logs = await client.getLogs({
        address: AAVE_POOL_ADDRESS,
        event: eventAbi,
        fromBlock,
        toBlock
      });
      return logs;
    } catch {
      // Bir sonraki RPC istemcisini dene
    }
  }

  // Eger aralik cok buyukse ikiye bolerek dene
  const span = toBlock - fromBlock;
  if (span > 2000n) {
    const mid = fromBlock + span / 2n;
    const left = await getLogsResilient(eventAbi, fromBlock, mid);
    const right = await getLogsResilient(eventAbi, mid + 1n, toBlock);
    return [...left, ...right];
  }
  return [];
}

function formatBotReason(
  botStatusCode: LiquidationRecord['botStatusCode'],
  debtUSD: number,
  debtSymbol: string,
  colSymbol: string,
  liquidator: string
): string {
  if (botStatusCode === 'OUR_BOT') {
    return 'Bu pozisyon doğrudan bizim tasfiye kontratımız tarafından vuruldu.';
  }
  if (botStatusCode === 'SKIPPED_DUST') {
    return `Kapatılan borç ($${debtUSD.toFixed(2)}) zarar koruma alt sınırı olan $25.00 altında (Gas masrafı kârdan yüksek).`;
  }
  if (botStatusCode === 'SKIPPED_SAME_TOKEN') {
    return `Borç ve teminat aynı varlık (${debtSymbol}); tekli Uniswap V3 havuzunda aynı token takas edilemez.`;
  }
  if (botStatusCode === 'UNSUPPORTED_TOKEN') {
    return `${colSymbol} -> ${debtSymbol} çifti botun 11 ana rezerv listesi dışında.`;
  }
  if (botStatusCode === 'NOT_IN_RADAR') {
    return 'Cüzdan daha önce yerel izleme listesinde (monitored_users.json) yoktu; şimdi otomatik eklendi.';
  }
  return `Cüzdan radarımızdaydı; rakip kontrat (${liquidator.slice(0, 8)}...) blok içinde daha düşük gecikmeyle onay aldı.`;
}
function evaluateLiquidationRecord(
  txHash: string,
  blockNumber: number,
  user: `0x${string}`,
  liquidator: `0x${string}`,
  collateralAsset: `0x${string}`,
  debtAsset: `0x${string}`,
  debtToCover: bigint,
  liquidatedCollateralAmount: bigint
): LiquidationRecord {
  const colMeta = tokenMetaCache.get(collateralAsset.toLowerCase()) || {
    symbol: collateralAsset.slice(0, 6),
    decimals: 18,
    priceUSD: 0,
    isSupportedByBot: false
  };
  const debtMeta = tokenMetaCache.get(debtAsset.toLowerCase()) || {
    symbol: debtAsset.slice(0, 6),
    decimals: 18,
    priceUSD: 0,
    isSupportedByBot: false
  };

  const debtAmountFormatted = Number(formatUnits(debtToCover, debtMeta.decimals));
  const debtUSD = debtAmountFormatted * debtMeta.priceUSD;

  const collateralAmountFormatted = Number(formatUnits(liquidatedCollateralAmount, colMeta.decimals));
  const collateralUSD = collateralAmountFormatted * colMeta.priceUSD;

  const bonusUSD = collateralUSD - debtUSD;

  // Blok numarasindan yaklasik zaman damgasini hesapla (Arbitrum ~0.25sn / blok)
  const blockDiff = Number(currentBlockNum > BigInt(blockNumber) ? currentBlockNum - BigInt(blockNumber) : 0n);
  const estimatedTimestampMs = (currentBlockTimestampSec - Math.round(blockDiff * 0.25)) * 1000;

  const wasInRadar = initialRadarSet.has(user.toLowerCase());
  const isOurBot =
    liquidator.toLowerCase() === OUR_BOT_CONTRACT_ADDRESS.toLowerCase() ||
    (walletAddress.startsWith('0x') && liquidator.toLowerCase() === walletAddress.toLowerCase());

  const sameToken = collateralAsset.toLowerCase() === debtAsset.toLowerCase();
  const bothSupported = colMeta.isSupportedByBot && debtMeta.isSupportedByBot;
  const isDust = debtUSD < 25.0;
  const isRealOpportunity = !isDust && !sameToken;

  let botStatusCode: LiquidationRecord['botStatusCode'] = 'COMPETITOR_FAST';
  let botReasonText = '';

  if (isOurBot) {
    botStatusCode = 'OUR_BOT';
  } else if (isDust) {
    botStatusCode = 'SKIPPED_DUST';
  } else if (sameToken) {
    botStatusCode = 'SKIPPED_SAME_TOKEN';
  } else if (!bothSupported) {
    botStatusCode = 'UNSUPPORTED_TOKEN';
  } else if (!wasInRadar) {
    botStatusCode = 'NOT_IN_RADAR';
  } else {
    botStatusCode = 'COMPETITOR_FAST';
  }

  botReasonText = formatBotReason(botStatusCode, debtUSD, debtMeta.symbol, colMeta.symbol, liquidator);

  return {
    txHash,
    blockNumber,
    timestampMs: estimatedTimestampMs,
    user,
    liquidator,
    collateralAsset,
    collateralSymbol: colMeta.symbol,
    collateralAmountRaw: liquidatedCollateralAmount.toString(),
    collateralAmountFormatted,
    collateralUSD,
    debtAsset,
    debtSymbol: debtMeta.symbol,
    debtAmountRaw: debtToCover.toString(),
    debtAmountFormatted,
    debtUSD,
    bonusUSD,
    wasInRadar,
    isRealOpportunity,
    botStatusCode,
    botReasonText
  };
}

async function scanSevenDaysLiquidations(forceFull = false) {
  if (isScanningLiquidations) return;
  isScanningLiquidations = true;

  try {
    // Arbitrum One: ~4 blok/saniye => 7 gun = ~2,419,200 blok
    const SEVEN_DAYS_BLOCKS = 2400000n;
    const CHUNK_SIZE = 80000n;

    if (forceFull) {
      liquidationsMap.clear();
      cachedFullScanDone = false;
      cachedHighestBlock = 0n;
    }

    const latestBlock = await publicClient.getBlockNumber();
    currentBlockNum = latestBlock;
    const sevenDayStartBlock = latestBlock > SEVEN_DAYS_BLOCKS ? latestBlock - SEVEN_DAYS_BLOCKS : 1n;
    const startBlock =
      cachedFullScanDone && cachedHighestBlock > sevenDayStartBlock
        ? cachedHighestBlock
        : sevenDayStartBlock;

    // Geriye dogru parcali tarama (En guncel tasfiyeler ilk saniyede ekrana duser)
    const chunks: { from: bigint; to: bigint }[] = [];
    for (let to = latestBlock; to > startBlock; to -= CHUNK_SIZE) {
      const from = to - CHUNK_SIZE + 1n > startBlock ? to - CHUNK_SIZE + 1n : startBlock;
      chunks.push({ from, to });
    }

    let completed = 0;
    const CONCURRENCY = 3;

    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const batchLogs = await Promise.all(
        batch.map(c => getLogsResilient(liquidationCallEventAbi, c.from, c.to))
      );

      const flatLogs = batchLogs.flat();
      if (flatLogs.length > 0) {
        const extraTokens: `0x${string}`[] = [];
        for (const lg of flatLogs) {
          if (lg.args?.collateralAsset) extraTokens.push(getAddress(lg.args.collateralAsset));
          if (lg.args?.debtAsset) extraTokens.push(getAddress(lg.args.debtAsset));
        }
        await refreshKnownPricesAndMeta(extraTokens);

        let addedNewUser = false;
        for (const lg of flatLogs) {
          const user = getAddress(lg.args.user);
          const liquidator = getAddress(lg.args.liquidator);
          const collateralAsset = getAddress(lg.args.collateralAsset);
          const debtAsset = getAddress(lg.args.debtAsset);
          const debtToCover = BigInt(lg.args.debtToCover || 0n);
          const liquidatedCollateralAmount = BigInt(lg.args.liquidatedCollateralAmount || 0n);
          const blockNumber = Number(lg.blockNumber || 0n);
          const txHash = String(lg.transactionHash || '');

          const rec = evaluateLiquidationRecord(
            txHash,
            blockNumber,
            user,
            liquidator,
            collateralAsset,
            debtAsset,
            debtToCover,
            liquidatedCollateralAmount
          );
          liquidationsMap.set(`${txHash}-${user}`, rec);

          if (!monitoredUsersSet.has(user)) {
            monitoredUsersSet.add(user);
            addedNewUser = true;
          }
        }

        if (addedNewUser) {
          scheduleSaveMonitoredUsers();
        }
        saveLiquidationCacheToDisk();
      }

      completed += batch.length;
      scanProgress.liqPct = Math.min(100, Math.round((completed / chunks.length) * 100));
      scanProgress.statusText = `Son 7 günlük tasfiye geçmişi taranıyor (%${scanProgress.liqPct}) | Bulunan tasfiye: ${liquidationsMap.size}`;
      lastUpdatedMs = Date.now();
    }

    scanProgress.liqPct = 100;
    saveLiquidationCacheToDisk(latestBlock, true);
    scanProgress.statusText = `Aktif izleme devrede | İzlenen cüzdan: ${monitoredUsersSet.size} | Son 7 gün tasfiye: ${liquidationsMap.size}`;
  } catch (err: any) {
    console.error(`[WARN] 7-day liquidation scan error: ${err.message}`);
  } finally {
    isScanningLiquidations = false;
  }
}

// ============================================================================
// 8. AKTIF BORCLU RADARI MULTICALL TARAMASI VE CANLI BORROW AKISI
// ============================================================================
async function scanBorrowersMulticall(addressesToScan?: `0x${string}`[]) {
  if (isScanningBorrowers && !addressesToScan) return;
  if (!addressesToScan) isScanningBorrowers = true;

  try {
    const allAddresses = addressesToScan || Array.from(monitoredUsersSet);
    if (allAddresses.length === 0) {
      scanProgress.borrowerPct = 100;
      return;
    }

    const BATCH_SIZE = 80;
    for (let i = 0; i < allAddresses.length; i += BATCH_SIZE) {
      const chunk = allAddresses.slice(i, i + BATCH_SIZE);
      const contracts = chunk.map(addr => ({
        address: AAVE_POOL_ADDRESS,
        abi: [getUserAccountDataAbi] as const,
        functionName: 'getUserAccountData' as const,
        args: [addr] as const
      }));

      const results = await publicClient.multicall({ contracts, allowFailure: true });
      const now = Date.now();

      for (let j = 0; j < chunk.length; j++) {
        const res = results[j];
        const addr = chunk[j];
        if (res.status === 'success' && res.result) {
          const [totalColBase, totalDebtBase, availBorrowsBase, liqThreshold, ltv, hfRaw] =
            res.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

          const totalCollateralUSD = Number(totalColBase) / 1e8;
          const totalDebtUSD = Number(totalDebtBase) / 1e8;
          const availableBorrowsUSD = Number(availBorrowsBase) / 1e8;
          const liquidationThresholdPct = Number(liqThreshold) / 100;
          const ltvPct = Number(ltv) / 100;
          const healthFactor = Number(hfRaw) / 1e18;

          borrowersMap.set(addr.toLowerCase(), {
            address: addr,
            totalCollateralUSD,
            totalDebtUSD,
            availableBorrowsUSD,
            liquidationThresholdPct,
            ltvPct,
            healthFactor,
            updatedAt: now
          });
        }
      }

      if (!addressesToScan) {
        scanProgress.borrowerPct = Math.min(
          100,
          Math.round(((i + chunk.length) / allAddresses.length) * 100)
        );
      }
    }

    if (!addressesToScan) {
      scanProgress.borrowerPct = 100;
    }
    lastUpdatedMs = Date.now();
  } catch (err: any) {
    console.error(`[WARN] Borrower multicall scan warning: ${err.shortMessage || err.message}`);
  } finally {
    if (!addressesToScan) isScanningBorrowers = false;
  }
}

async function fetchRecentBorrowEvents(lookbackBlocks = 15000n) {
  try {
    const latest = await publicClient.getBlockNumber();
    currentBlockNum = latest;
    const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 1n;

    const logs = await getLogsResilient(borrowEventAbi, fromBlock, latest);
    if (logs.length === 0) return;

    const extraTokens: `0x${string}`[] = [];
    const borrowerAddrs = new Set<`0x${string}`>();

    for (const lg of logs) {
      if (lg.args?.reserve) extraTokens.push(getAddress(lg.args.reserve));
      const borrower = lg.args?.onBehalfOf || lg.args?.user;
      if (borrower && isAddress(borrower)) {
        const u = getAddress(borrower);
        borrowerAddrs.add(u);
        if (!monitoredUsersSet.has(u)) {
          monitoredUsersSet.add(u);
        }
      }
    }

    scheduleSaveMonitoredUsers();
    await refreshKnownPricesAndMeta(extraTokens);
    await scanBorrowersMulticall(Array.from(borrowerAddrs));

    for (const lg of logs) {
      const borrower = lg.args?.onBehalfOf || lg.args?.user;
      if (!borrower || !lg.args?.reserve) continue;
      const user = getAddress(borrower);
      const reserve = getAddress(lg.args.reserve);
      const amountRaw = BigInt(lg.args.amount || 0n);
      const rateMode = Number(lg.args.interestRateMode || 2);
      const blockNumber = Number(lg.blockNumber || 0n);
      const txHash = String(lg.transactionHash || '');

      const meta = tokenMetaCache.get(reserve.toLowerCase()) || {
        symbol: reserve.slice(0, 6),
        decimals: 18,
        priceUSD: 0,
        isSupportedByBot: false
      };

      const amountFormatted = Number(formatUnits(amountRaw, meta.decimals));
      const amountUSD = amountFormatted * meta.priceUSD;

      const blockDiff = Number(currentBlockNum > BigInt(blockNumber) ? currentBlockNum - BigInt(blockNumber) : 0n);
      const timestampMs = (currentBlockTimestampSec - Math.round(blockDiff * 0.25)) * 1000;

      const bInfo = borrowersMap.get(user.toLowerCase());

      liveBorrowsMap.set(`${txHash}-${user}-${reserve}`, {
        txHash,
        blockNumber,
        timestampMs,
        user,
        reserve,
        assetSymbol: meta.symbol,
        amountFormatted,
        amountUSD,
        interestRateMode: rateMode,
        userTotalDebtUSD: bInfo ? bInfo.totalDebtUSD : amountUSD,
        userHealthFactor: bInfo ? bInfo.healthFactor : 999
      });
    }
  } catch (err: any) {
    console.error(`[WARN] Recent borrow fetch warning: ${err.shortMessage || err.message}`);
  }
}

async function refreshNetworkMeta() {
  try {
    const block = await publicClient.getBlock();
    currentBlockNum = block.number;
    currentBlockTimestampSec = Number(block.timestamp);

    if (walletAddress.startsWith('0x')) {
      const bal = await publicClient.getBalance({ address: walletAddress as `0x${string}` });
      ethBalanceFormatted = Number(formatUnits(bal, 18));
    }
    lastUpdatedMs = Date.now();
  } catch {
    // Gecici RPC hatasini sessizce gec
  }
}

// ============================================================================
// 9. KULLANICI DETAY SORGUSU (/api/user-details)
// ============================================================================
async function getUserPositionDetails(userAddress: `0x${string}`) {
  await refreshKnownPricesAndMeta();

  const contracts = [
    {
      address: AAVE_POOL_ADDRESS,
      abi: [getUserAccountDataAbi] as const,
      functionName: 'getUserAccountData' as const,
      args: [userAddress] as const
    },
    ...KNOWN_RESERVES.map(r => ({
      address: AAVE_DATA_PROVIDER_ADDRESS,
      abi: [getUserReserveDataAbi] as const,
      functionName: 'getUserReserveData' as const,
      args: [r.address, userAddress] as const
    }))
  ];

  const results = await publicClient.multicall({ contracts, allowFailure: true });

  let totalCollateralUSD = 0;
  let totalDebtUSD = 0;
  let healthFactor = 999;

  if (results[0].status === 'success' && results[0].result) {
    const [colBase, debtBase, , , , hfRaw] = results[0].result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint
    ];
    totalCollateralUSD = Number(colBase) / 1e8;
    totalDebtUSD = Number(debtBase) / 1e8;
    healthFactor = Number(hfRaw) / 1e18;
  }

  const collaterals: { name: string; amount: number; priceUSD: number; usd: number }[] = [];
  const debts: { name: string; amount: number; priceUSD: number; usd: number }[] = [];

  for (let i = 0; i < KNOWN_RESERVES.length; i++) {
    const reserve = KNOWN_RESERVES[i];
    const res = results[i + 1];
    if (res.status === 'success' && res.result) {
      const [aTokenBal, stableDebt, variableDebt, , , , , , usageAsCol] = res.result as readonly [
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
      const meta = tokenMetaCache.get(reserve.address.toLowerCase());
      const priceUSD = meta ? meta.priceUSD : 1.0;

      if (aTokenBal > 0n) {
        const amt = Number(formatUnits(aTokenBal, reserve.decimals));
        const usd = amt * priceUSD;
        if (usd >= 0.01) {
          collaterals.push({
            name: usageAsCol ? reserve.symbol : `${reserve.symbol} (Teminat Dışı)`,
            amount: amt,
            priceUSD,
            usd
          });
        }
      }

      const totDebt = stableDebt + variableDebt;
      if (totDebt > 0n) {
        const amt = Number(formatUnits(totDebt, reserve.decimals));
        const usd = amt * priceUSD;
        if (usd >= 0.01) {
          debts.push({
            name: reserve.symbol,
            amount: amt,
            priceUSD,
            usd
          });
        }
      }
    }
  }

  collaterals.sort((a, b) => b.usd - a.usd);
  debts.sort((a, b) => b.usd - a.usd);

  return {
    address: userAddress,
    totalCollateralUSD,
    totalDebtUSD,
    healthFactor,
    collaterals,
    debts
  };
}

// ============================================================================
// 10. SEKME KAPANMA ALGILAYICISI VE HTTP SUNUCUSU (SADECE 127.0.0.1)
// ============================================================================
let activeTabStreams = 0;
let autoShutdownTimer: NodeJS.Timeout | null = null;

function cancelAutoShutdown() {
  if (autoShutdownTimer) {
    clearTimeout(autoShutdownTimer);
    autoShutdownTimer = null;
  }
}

function scheduleAutoShutdown(delayMs = 2500) {
  cancelAutoShutdown();
  autoShutdownTimer = setTimeout(() => {
    if (activeTabStreams === 0) {
      console.log('[SYSTEM] Browser tab closed. Shutting down local dashboard process.');
      process.exit(0);
    }
  }, delayMs);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || '/', true);
  const pathname = parsedUrl.pathname || '/';

  if (pathname === '/' || pathname === '/index.html') {
    cancelAutoShutdown();
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`HTML okuma hatasi: ${err.message}`);
    }
    return;
  }

  // Tarayici sekmesi acik oldugu surece canli kalan TCP akisi; sekme kapandigi milisaniye req.on('close') tetiklenir
  if (pathname === '/api/live-connection') {
    cancelAutoShutdown();
    activeTabStreams++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('data: connected\n\n');

    const keepAlive = setInterval(() => {
      try {
        res.write('data: ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      activeTabStreams = Math.max(0, activeTabStreams - 1);
      if (activeTabStreams === 0) {
        // F5 (sayfa yenileme) durumuna izin vermek icin 2.5 saniye bekle; yeni sekme baglanmazsa sureci tamamen kapat
        scheduleAutoShutdown(2500);
      }
    });
    return;
  }

  if (pathname === '/api/tab-closed') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    if (activeTabStreams === 0) {
      scheduleAutoShutdown(2000);
    }
    return;
  }

  if (pathname === '/api/state') {
    const liquidations = Array.from(liquidationsMap.values()).sort(
      (a, b) => b.blockNumber - a.blockNumber
    );
    const borrowers = Array.from(borrowersMap.values()).sort(
      (a, b) => a.healthFactor - b.healthFactor
    );
    const liveBorrows = Array.from(liveBorrowsMap.values())
      .sort((a, b) => b.blockNumber - a.blockNumber)
      .slice(0, 100);

    const payload = {
      meta: {
        currentBlock: currentBlockNum.toString(),
        botContract: OUR_BOT_CONTRACT_ADDRESS,
        walletAddress,
        ethBalance: ethBalanceFormatted,
        ethBalanceUSD: ethBalanceFormatted * ethPriceUSD,
        totalMonitoredCount: monitoredUsersSet.size,
        lastUpdated: lastUpdatedMs
      },
      scanProgress,
      liquidations,
      borrowers,
      liveBorrows
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (pathname === '/api/user-details') {
    const addrParam = String(parsedUrl.query.address || '');
    if (!isAddress(addrParam)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gecersiz cuzdan adresi' }));
      return;
    }
    try {
      const details = await getUserPositionDetails(getAddress(addrParam));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(details));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/refresh' && req.method === 'POST') {
    refreshNetworkMeta();
    fetchRecentBorrowEvents(5000n);
    scanBorrowersMulticall();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/sync-borrowers' && req.method === 'POST') {
    fetchRecentBorrowEvents(35000n);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/rescan-liquidations' && req.method === 'POST') {
    scanSevenDaysLiquidations(true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/shutdown' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => process.exit(0), 200);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 - Bulunamadı');
});

// ============================================================================
// 11. BASLATMA VE PERIYODIK GUNCELLEME DONGULERI
// ============================================================================
async function startDashboard() {
  console.log('==============================================================');
  console.log('[SYSTEM] AAVE V3 ARBITRUM LOCAL ADMIN DASHBOARD STARTING');
  console.log('==============================================================');

  loadMonitoredUsersFromDisk();
  loadLiquidationCacheFromDisk();

  server.listen(PORT, HOST, () => {
    console.log(`[SYSTEM] Dashboard online at: http://${HOST}:${PORT}`);
  });

  await refreshNetworkMeta();
  await refreshKnownPricesAndMeta();

  // Paralel baslangic taramalari
  scanBorrowersMulticall();
  fetchRecentBorrowEvents(15000n);
  scanSevenDaysLiquidations(false);

  // Riskli borclulari ve son bloklari duzenli guncelle
  setInterval(async () => {
    await refreshNetworkMeta();
    await fetchRecentBorrowEvents(1500n);

    // HF < 1.15 olan kritik cuzdanlari oncelikli yenile
    const priorityTargets = Array.from(borrowersMap.values())
      .filter(b => b.totalDebtUSD >= 50 && b.healthFactor > 0 && b.healthFactor < 1.15)
      .map(b => b.address);

    if (priorityTargets.length > 0) {
      await scanBorrowersMulticall(priorityTargets);
    }
  }, 6000);

  // Tum borclu veritabanini ve yeni tasfiyeleri her 30 saniyede bir yenile
  setInterval(() => {
    scanBorrowersMulticall();
    scanSevenDaysLiquidations(false);
  }, 30000);
}

startDashboard().catch(err => {
  console.error(`[FATAL] Dashboard failed to start: ${err.message}`);
});
