import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
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
import * as https from 'https';

// Ortam değişkenlerini her zaman bot/.env dosyasından yükler (PM2 çalışma dizininden bağımsız).
dotenv.config({ path: path.join(__dirname, '../.env') });

// ============================================================================
// 1. HİBRİT AĞ, ÇOKLU ÜCRETSİZ RPC HAVUZU VE ÖZEL SNIPER API YAPILANDIRMASI
// ============================================================================
const primaryRpcUrl =
  process.env.LOCAL_FORK_URL || process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';

// Özel Keskin Nişancı API (Alchemy): Sadece HF < 1.012, simulateContract ve işlem yayını anında kullanılır (Ücretsiz kotayı korur)
const sniperRpcUrl = process.env.SNIPER_RPC_URL || primaryRpcUrl;
const arbitrumWssUrl = process.env.ARBITRUM_WSS_URL || 'wss://arbitrum-one-rpc.publicnode.com';

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  console.error('[ERROR] PRIVATE_KEY not found in .env file.');
  process.exit(1);
}

const account = privateKeyToAccount(
  privateKey.startsWith('0x') ? (privateKey as `0x${string}`) : `0x${privateKey}`
);
const chainToUse = process.env.LOCAL_FORK_URL ? localhost : arbitrum;

// Viem fallback transport ile otomatik yedekli genel okuma istemcisi
const publicClient = createPublicClient({
  chain: chainToUse,
  transport: process.env.LOCAL_FORK_URL
    ? http(primaryRpcUrl, { timeout: 10000 })
    : fallback([
        http(primaryRpcUrl, { timeout: 10000 }),
        http('https://arbitrum-one-rpc.publicnode.com', { timeout: 10000 }),
        http('https://arbitrum.drpc.org', { timeout: 10000 }),
        http('https://arb1.arbitrum.io/rpc', { timeout: 10000 })
      ])
});

// Özel Keskin Nişancı İstemcisi (Sniper Client): Vuruş ve simülasyon anında en düşük gecikmeli özel Alchemy düğümünü kullanır
const sniperClient = createPublicClient({
  chain: chainToUse,
  transport: process.env.LOCAL_FORK_URL
    ? http(primaryRpcUrl, { timeout: 8000 })
    : fallback([
        http(sniperRpcUrl, { timeout: 6000 }),
        http('https://arb1.arbitrum.io/rpc', { timeout: 6000 }),
        http('https://arbitrum-one-rpc.publicnode.com', { timeout: 6000 })
      ])
});

// Çoklu Ücretsiz Okuma Havuzu (Round-Robin): 3.800+ cüzdanlık taramalarda özel API kotasını hiç harcamadan yükü 4 ücretsiz düğüme dağıtır.
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
        transport: http('https://arbitrum.drpc.org', { timeout: 10000 })
      }),
      createPublicClient({
        chain: arbitrum,
        transport: http('https://1rpc.io/arb', { timeout: 10000 })
      })
    ];

let readClientIndex = 0;
function getNextReadClient() {
  const client = readClients[readClientIndex % readClients.length];
  readClientIndex++;
  return client;
}

// Çoklu Yazma (Broadcast) Havuzu: İşlemi aynı milisaniyede hem doğrudan Arbitrum Resmi Sequencer'ına, hem Özel Alchemy düğümüne hem de alternatif düğümlere ateşler.
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
        transport: http(sniperRpcUrl, { timeout: 8000 })
      }),
      createWalletClient({
        account,
        chain: arbitrum,
        transport: http('https://arbitrum-one-rpc.publicnode.com', { timeout: 8000 })
      }),
      createWalletClient({
        account,
        chain: arbitrum,
        transport: http('https://arbitrum.drpc.org', { timeout: 8000 })
      })
    ];

// VURUŞ ANINDA 0ms GECİKME İÇİN ÖN-BELLEKLİ NONCE, GAS VE BAKİYE PARAMETRELERİ:
let cachedGasPriceWei = 20000000n; // Varsayılan 0.02 Gwei
let cachedGasPriceGwei = 0.02;
let cachedNonce: number | undefined = undefined;
let cachedHotWalletEth = 0;
let lastBalanceCheckMs = 0;

async function refreshExecutionParams() {
  try {
    const now = Date.now();
    const shouldCheckBalance = now - lastBalanceCheckMs >= 60000 || lastBalanceCheckMs === 0;
    const [gp, nonce, bal] = await Promise.all([
      publicClient.getGasPrice(),
      publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      shouldCheckBalance ? publicClient.getBalance({ address: account.address }) : Promise.resolve(null)
    ]);
    cachedGasPriceWei = gp;
    cachedGasPriceGwei = Number(gp) / 1e9;
    cachedNonce = nonce;
    if (bal !== null) {
      lastBalanceCheckMs = now;
      cachedHotWalletEth = Number(formatUnits(bal, 18));
      if (cachedHotWalletEth > 0 && cachedHotWalletEth < 0.0005) {
        sendTelegramAlert(
          'low_gas_balance',
          `<b>[KRİTİK SİSTEM UYARISI — DÜŞÜK GAS BAKİYESİ]</b>\n────────────────────────\n<b>Durum:</b> Sıcak işlem cüzdanındaki ETH bakiyesi kritik sınırın altına düştü.\n<b>Cüzdan:</b> <code>${account.address}</code>\n<b>Mevcut Bakiye:</b> ${cachedHotWalletEth.toFixed(6)} ETH\n<b>Önerilen İşlem:</b> Tasfiye işlemlerinin kesintiye uğramaması için Arbitrum ağı üzerinden en az 0.002 ETH aktarınız.`,
          6 * 60 * 60 * 1000
        );
      }
    }
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
const UNISWAP_QUOTER_V2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const;

// Arbitrum üzerindeki ana Chainlink fiyat kâhini (Aggregator) adresleri (Açılışta dinamik olarak tüm rezervlerle genişletilir)
let chainlinkAggregators: `0x${string}`[] = [
  '0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83', // WETH / USD
  '0xE7c522c60bA7f1b5E398D2312593713e2B19aeb0', // WBTC / USD
  '0xB72359B2dc04Ff363e094648DF78247c98297c20'  // ARB / USD
];

const rawTelegramToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const telegramBotToken =
  rawTelegramToken && !rawTelegramToken.includes('BURAYA_') ? rawTelegramToken : '';
const rawTelegramChatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
let activeTelegramChatId =
  /^-?\d+$/.test(rawTelegramChatId) ? rawTelegramChatId : '';
const telegramThrottleMap = new Map<string, number>();

function callTelegramApi(method: string, payload: Record<string, any>, timeoutMs = 10000): Promise<any> {
  return new Promise(resolve => {
    if (!telegramBotToken) return resolve(null);
    const bodyStr = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${telegramBotToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr)
        },
        timeout: timeoutMs
      },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(bodyStr);
    req.end();
  });
}

// Yalnızca gerçekleşen tasfiye işlemlerinde ve kritik sistem arızalarında kurumsal bildirim gönderir
function sendTelegramAlert(key: string, message: string, minIntervalMs = 0) {
  if (!telegramBotToken || !activeTelegramChatId) return;
  const now = Date.now();
  if (minIntervalMs > 0) {
    const last = telegramThrottleMap.get(key) || 0;
    if (now - last < minIntervalMs) return;
    telegramThrottleMap.set(key, now);
  }
  callTelegramApi('sendMessage', {
    chat_id: activeTelegramChatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }).catch(() => {});
}

const rawBotContractAddr = (
  process.env.BOT_CONTRACT_ADDRESS || '0x1CA5f9cACbee5533E03FD643E2d4BC89af667c6c'
)
  .trim()
  .toLowerCase();
if (!rawBotContractAddr || !isAddress(rawBotContractAddr)) {
  throw new Error('FATAL: Valid BOT_CONTRACT_ADDRESS is required in .env');
}
const OUR_BOT_CONTRACT_ADDRESS = getAddress(rawBotContractAddr);
let cachedEthPriceUSD = 2600;
let lastValidOraclePrices: { prices: bigint[]; updatedAt: number; count: number } | null = null;

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
const getSourceOfAssetAbi = parseAbiItem('function getSourceOfAsset(address asset) view returns (address)');
const aggregatorAbi = parseAbiItem('function aggregator() view returns (address)');
const answerUpdatedEventAbi = parseAbiItem(
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)'
);
const quoteExactInputSingleAbi = parseAbiItem(
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
);
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

      // Aktif rezervlerin Chainlink Aggregator adreslerini dinamik olarak keşfet
      try {
        const sourceContracts = discovered.map(d => ({
          address: AAVE_ORACLE_ADDRESS,
          abi: [getSourceOfAssetAbi] as const,
          functionName: 'getSourceOfAsset' as const,
          args: [d.address] as const
        }));
        const sourceRes = await publicClient.multicall({
          contracts: sourceContracts,
          allowFailure: true
        });
        const sources: `0x${string}`[] = [];
        for (const r of sourceRes) {
          if (r.status === 'success' && r.result && isAddress(r.result as string)) {
            sources.push(getAddress(r.result as string));
          }
        }
        if (sources.length > 0) {
          const aggContracts = sources.map(s => ({
            address: s,
            abi: [aggregatorAbi] as const,
            functionName: 'aggregator' as const
          }));
          const aggRes = await publicClient.multicall({
            contracts: aggContracts,
            allowFailure: true
          });
          const aggSet = new Set<`0x${string}`>(chainlinkAggregators);
          for (let k = 0; k < sources.length; k++) {
            const ar = aggRes[k];
            if (ar?.status === 'success' && ar.result && isAddress(ar.result as string)) {
              aggSet.add(getAddress(ar.result as string));
            } else {
              aggSet.add(sources[k]);
            }
          }
          chainlinkAggregators = Array.from(aggSet);
        }
      } catch {
        // Varsayılan Chainlink aggregator listesiyle devam et
      }

      logInfo(
        `Synchronized ${discovered.length} active Aave V3 reserves, ${eModeCategories.size} eMode categories, and ${chainlinkAggregators.length} Chainlink price feeds dynamically (${discovered.map(d => d.name).join(', ')}).`
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
const imminentTargets = new Set<`0x${string}`>(); // HF < 1.012 (Özel Sniper API + WSS Blok Tetikleyicisi ile izlenir)
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
  collateralDecimals: number;
  collateralPriceUSD: number;
  collateralUSD: number;
  liquidationBonusRatio: number;
  bestPoolFee: number;
}

const targetStrikeCache = new Map<
  `0x${string}`,
  { candidates: LiquidationCandidate[]; updatedAt: number }
>();

// TELEGRAM KONTROL PANELİ İÇİN CANLI BELLEK VERİLERİ (Sıfır Ek RPC Maliyeti)
const botStartTimeMs = Date.now();
let latestObservedBlock = 0n;
let cachedProfitRecipient = '0xF4cd5A9e10b3FC3892c22066697aAC882B5B91EF';
const sessionStats = {
  simulationsRun: 0,
  strikesSucceeded: 0,
  totalNetProfitUSD: 0
};
const borrowerSnapshots = new Map<
  `0x${string}`,
  { hf: number; collateralUSD: number; debtUSD: number; updatedAt: number }
>();
interface ObservedLiquidation {
  blockNumber: bigint;
  txHash: string;
  user: `0x${string}`;
  liquidator: string;
  inRadar: boolean;
  isOurBot: boolean;
  timestampMs: number;
}
const recentNetworkLiquidations: ObservedLiquidation[] = [];

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
          lastValidOraclePrices = {
            prices: candidatePrices,
            updatedAt: Date.now(),
            count: reservesSnapshot.length
          };
          break;
        }
      } catch {
        // Sıradaki RPC ile tekrar dene
      }
    }

    // Anlık RPC kesintisinde son 30 saniye içinde alınmış taze Oracle fiyatı varsa onu kullan
    if (
      (!pricesRaw || pricesRaw.length !== reservesSnapshot.length) &&
      lastValidOraclePrices &&
      lastValidOraclePrices.count === reservesSnapshot.length &&
      Date.now() - lastValidOraclePrices.updatedAt < 30000
    ) {
      pricesRaw = lastValidOraclePrices.prices;
    }

    // ORACLE KORUMASI: Tüm RPC'lerde fiyat verisi alınamadıysa yanlış varsayılan (1.0$) kullanmak yerine değerlendirmeyi durdur.
    if (!pricesRaw || pricesRaw.length !== reservesSnapshot.length) {
      logThrottledWarn('oracle_null', `Oracle price array incomplete for ${userAddress}; skipping evaluation.`);
      return [];
    }

    const userDebts: { asset: ReserveAsset; amount: bigint; priceUSD: number; usd: number }[] = [];
    const userCollaterals: { asset: ReserveAsset; priceUSD: number; usd: number }[] = [];

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
            userCollaterals.push({ asset, priceUSD, usd: colValueUSD });
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
            collateralDecimals: c.asset.decimals,
            collateralPriceUSD: c.priceUSD,
            collateralUSD: c.usd,
            liquidationBonusRatio: effectiveBonusRatio,
            bestPoolFee: 500
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
      // Uniswap V3 QuoterV2 (Sıfır Gas, Multicall): Her aday çift için [100, 500, 3000, 10000] havuzlarını önceden sorgula
      // ve en yüksek net çıktıyı veren havuz komisyonunu (bestPoolFee) vuruş önbelleğine kaydet
      const feeTiers = [100, 500, 3000, 10000] as const;
      const quoteContracts = topCandidates.flatMap(cand => {
        const estCoverUSD = Math.min(cand.debtUSD, cand.collateralUSD / cand.liquidationBonusRatio);
        const estColTokens =
          cand.collateralPriceUSD > 0
            ? (estCoverUSD * cand.liquidationBonusRatio) / cand.collateralPriceUSD
            : 0;
        const estColAmountRaw =
          BigInt(
            Math.max(1, Math.floor(estColTokens * Math.pow(10, Math.min(cand.collateralDecimals, 8))))
          ) * (cand.collateralDecimals > 8 ? 10n ** BigInt(cand.collateralDecimals - 8) : 1n);

        return feeTiers.map(fee => ({
          address: UNISWAP_QUOTER_V2_ADDRESS,
          abi: [quoteExactInputSingleAbi] as const,
          functionName: 'quoteExactInputSingle' as const,
          args: [
            {
              tokenIn: cand.collateralAsset,
              tokenOut: cand.debtAsset,
              amountIn: estColAmountRaw,
              fee,
              sqrtPriceLimitX96: 0n
            }
          ] as const
        }));
      });

      try {
        const quoteResults = await getNextReadClient().multicall({
          contracts: quoteContracts,
          allowFailure: true
        });
        for (let cIdx = 0; cIdx < topCandidates.length; cIdx++) {
          let bestOut = 0n;
          let bestFee = 500;
          for (let fIdx = 0; fIdx < feeTiers.length; fIdx++) {
            const qRes = quoteResults[cIdx * feeTiers.length + fIdx];
            if (qRes?.status === 'success' && Array.isArray(qRes.result)) {
              const amountOut = qRes.result[0] as bigint;
              if (amountOut > bestOut) {
                bestOut = amountOut;
                bestFee = feeTiers[fIdx];
              }
            }
          }
          topCandidates[cIdx].bestPoolFee = bestFee;
        }
      } catch {
        // Quoter sorgusu başarısız olursa varsayılan 500 (ve sözleşme içi otomatik havuz yedeği) kullanılır
      }

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

  sessionStats.simulationsRun += plans.length;

  // PARALEL ÖN SİMÜLASYON (Özel Sniper API [Alchemy] + QuoterV2 En İyi Havuz Seçimi ile ~15ms gecikmeyle çalıştırılır)
  const simResults = await Promise.allSettled(
    plans.map(plan =>
      sniperClient.simulateContract({
        address: OUR_BOT_CONTRACT_ADDRESS,
        abi: botContractAbi,
        functionName: 'triggerLiquidation',
        args: [
          plan.target.debtAsset,
          plan.target.collateralAsset,
          userAddress,
          plan.amount,
          plan.target.bestPoolFee || 500,
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
        `SIMULATION PASSED [${plan.label} | Fee: ${plan.target.bestPoolFee || 500}]! BROADCASTING TO SEQUENCER (${plan.target.collateralName} -> ${plan.target.debtName} | Cover: ~$${plan.usd.toFixed(2)} | Est. Net: +$${plan.expectedNetBonusUSD.toFixed(2)})...`
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
          sessionStats.strikesSucceeded += 1;
          sessionStats.totalNetProfitUSD += plan.expectedNetBonusUSD;
          logAlert(
            `STRIKE EXECUTED SUCCESSFULLY! Confirmed in Block ${receipt.blockNumber} | TxHash: ${txHash}`
          );
          sendTelegramAlert(
            `strike_ok_${txHash}`,
            `<b>[TASFİYE İŞLEMİ ONAYLANDI]</b>\n────────────────────────\n<b>Blok Numarası:</b> <code>${receipt.blockNumber}</code>\n<b>Borçlu Adresi:</b> <code>${userAddress}</code>\n<b>Varlık Çifti:</b> ${plan.target.collateralName} -&gt; ${plan.target.debtName} (Havuz: ${plan.target.bestPoolFee || 500})\n<b>Kapatılan Borç:</b> $${plan.usd.toFixed(2)}\n<b>Tahmini Net Kâr:</b> +$${plan.expectedNetBonusUSD.toFixed(2)}\n<b>Kâr Kasası:</b> <code>${cachedProfitRecipient}</code>\n<b>İşlem Kaydı:</b> https://arbiscan.io/tx/${txHash}`,
            0
          );
          cooldowns.set(userAddress, Date.now() + 60000);
        } else {
          logInfo(`Transaction reverted on-chain in Block ${receipt.blockNumber} | TxHash: ${txHash}`);
          sendTelegramAlert(
            `tx_revert_${txHash}`,
            `<b>[KRİTİK SİSTEM UYARISI — İŞLEM REDDEDİLDİ]</b>\n────────────────────────\n<b>Durum:</b> Yayınlanan tasfiye işlemi zincir üstünde reddedildi (Reverted).\n<b>Blok Numarası:</b> <code>${receipt.blockNumber}</code>\n<b>Hedef Adres:</b> <code>${userAddress}</code>\n<b>Varlık Çifti:</b> ${plan.target.collateralName} -&gt; ${plan.target.debtName}\n<b>İşlem Kaydı:</b> https://arbiscan.io/tx/${txHash}`,
            0
          );
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

  const totalCollateralUSD = Number(data[0]) / 1e8;
  const totalDebtUSD = Number(data[1]) / 1e8;
  const healthFactor = Number(data[5]) / 1e18;

  if (healthFactor > 0 && healthFactor <= 1.25 && totalDebtUSD >= MIN_DEBT_USD) {
    borrowerSnapshots.set(userAddress, {
      hf: healthFactor,
      collateralUSD: totalCollateralUSD,
      debtUSD: totalDebtUSD,
      updatedAt: now
    });
  } else {
    borrowerSnapshots.delete(userAddress);
  }

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
    if (healthFactor < 1.012) {
      if (!imminentTargets.has(userAddress)) {
        imminentTargets.add(userAddress);
        logAlert(
          `IMMINENT LIQUIDATION TARGET (Private Sniper API + WSS Block Lock) | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`
        );
      }
    } else {
      imminentTargets.delete(userAddress);
    }
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
    imminentTargets.delete(userAddress);
    ultraCriticalTargets.delete(userAddress);
    if (!criticalTargets.has(userAddress)) {
      criticalTargets.add(userAddress);
      logAlert(
        `HIGH RISK BORROWER PROMOTED TO SNIPER RADAR | ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`
      );
    }
  } else {
    imminentTargets.delete(userAddress);
    ultraCriticalTargets.delete(userAddress);
    criticalTargets.delete(userAddress);
    targetStrikeCache.delete(userAddress);
    if (totalDebtUSD === 0) {
      activeUsers.delete(userAddress);
      scheduleSaveUsers();
    }
  }
}

async function checkUsersBatch(
  addresses: `0x${string}`[],
  useFastPool = false,
  usePrivateSniper = false
) {
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

    const client = usePrivateSniper
      ? sniperClient
      : useFastPool
        ? getNextReadClient()
        : publicClient;
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

// ============================================================================
// 9. TELEGRAM ETKİLEŞİMLİ KONTROL PANELİ (TARAYICI PANELİ KARŞILIĞI - SIFIR SPAM)
// ============================================================================
type PanelTab = 'overview' | 'borrowers' | 'liquidations' | 'wallet';

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days} gün ${hours} saat ${mins} dk`;
  if (hours > 0) return `${hours} saat ${mins} dk`;
  return `${mins} dakika`;
}

function buildTelegramPanelView(tab: PanelTab): { text: string; reply_markup: any } {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  let body = '';

  if (tab === 'overview') {
    body =
      `<b>[ARBITRUM AAVE V3 TASFİYE BOTU — YÖNETİM PANELİ]</b>\n` +
      `<b>Görünüm:</b> Genel Sistem Durumu\n` +
      `────────────────────────\n` +
      `<b>Sistem Durumu:</b> ÇEVRİMİÇİ (Hibrit Keskin Nişancı)\n` +
      `<b>Çalışma Süresi:</b> ${formatUptime(Date.now() - botStartTimeMs)}\n` +
      `<b>Son İşlenen Blok:</b> <code>${latestObservedBlock.toString()}</code>\n` +
      `<b>Ağ Gas Ücreti:</b> ${cachedGasPriceGwei.toFixed(3)} Gwei\n` +
      `<b>Güncel WETH Fiyatı:</b> $${cachedEthPriceUSD.toFixed(2)}\n` +
      `────────────────────────\n` +
      `<b>İzlenen Toplam Borçlu:</b> ${activeUsers.size}\n` +
      `<b>Anlık Vuruş Kilidi (HF &lt; 1.012):</b> ${imminentTargets.size} cüzdan\n` +
      `<b>Ultra-Kritik Radar (HF &lt; 1.045):</b> ${ultraCriticalTargets.size} cüzdan\n` +
      `<b>Kritik Radar (HF &lt;= 1.120):</b> ${criticalTargets.size} cüzdan\n` +
      `<b>Aktif Rezerv / Chainlink:</b> ${AAVE_RESERVE_ASSETS.length} varlık / ${chainlinkAggregators.length} besleme\n` +
      `────────────────────────\n` +
      `<b>Oturum Simülasyon Sayısı:</b> ${sessionStats.simulationsRun}\n` +
      `<b>Başarılı Tasfiye İşlemi:</b> ${sessionStats.strikesSucceeded}\n` +
      `<b>Oturum Tahmini Net Kâr:</b> $${sessionStats.totalNetProfitUSD.toFixed(2)}\n` +
      `────────────────────────\n` +
      `<b>Son Güncelleme:</b> ${nowStr}`;
  } else if (tab === 'borrowers') {
    const sorted = Array.from(borrowerSnapshots.entries())
      .map(([address, info]) => ({ address, ...info }))
      .sort((a, b) => a.hf - b.hf)
      .slice(0, 10);

    let listText = '';
    if (sorted.length === 0) {
      listText = `Şu anda Sağlık Faktörü 1.25 altında olan borçlu cüzdan bulunmamaktadır.\n`;
    } else {
      sorted.forEach((item, idx) => {
        const shortAddr = `${item.address.slice(0, 6)}...${item.address.slice(-4)}`;
        const cachedCand = targetStrikeCache.get(item.address)?.candidates?.[0];
        const pairStr = cachedCand
          ? `${cachedCand.collateralName}-&gt;${cachedCand.debtName}`
          : 'Hesaplanıyor';
        listText +=
          `<b>${idx + 1}.</b> <code>${shortAddr}</code> | <b>HF: ${item.hf.toFixed(4)}</b>\n` +
          `   Teminat: $${item.collateralUSD.toFixed(0)} | Borç: $${item.debtUSD.toFixed(0)} | Çift: ${pairStr}\n`;
      });
    }

    body =
      `<b>[ARBITRUM AAVE V3 TASFİYE BOTU — YÖNETİM PANELİ]</b>\n` +
      `<b>Görünüm:</b> Yüksek Riskli Borçlular (İlk 10)\n` +
      `────────────────────────\n` +
      listText +
      `────────────────────────\n` +
      `<b>Toplam Riskli Aday (HF &lt;= 1.25):</b> ${borrowerSnapshots.size} cüzdan\n` +
      `<b>Son Güncelleme:</b> ${nowStr}`;
  } else if (tab === 'liquidations') {
    let listText = '';
    if (recentNetworkLiquidations.length === 0) {
      listText = `Bot başlatıldığından bu yana ağ üzerinde yeni bir tasfiye işlemi gözlemlenmedi.\n`;
    } else {
      recentNetworkLiquidations.slice(0, 10).forEach((liq, idx) => {
        const shortUser = `${liq.user.slice(0, 6)}...${liq.user.slice(-4)}`;
        const executorLabel = liq.isOurBot ? 'BİZİM BOT' : 'RAKİP BOT';
        const radarLabel = liq.inRadar ? 'Radarda' : 'Radar Dışı';
        const timeStr = new Date(liq.timestampMs).toISOString().split('T')[1].slice(0, 8);
        listText +=
          `<b>${idx + 1}. Blok ${liq.blockNumber.toString()}</b> (${timeStr} UTC)\n` +
          `   Borçlu: <code>${shortUser}</code> | Yürüten: <b>${executorLabel}</b> (${radarLabel})\n`;
      });
    }

    body =
      `<b>[ARBITRUM AAVE V3 TASFİYE BOTU — YÖNETİM PANELİ]</b>\n` +
      `<b>Görünüm:</b> Ağdaki Son Tasfiye İşlemleri\n` +
      `────────────────────────\n` +
      listText +
      `────────────────────────\n` +
      `<b>Son Güncelleme:</b> ${nowStr}`;
  } else {
    const ethUsdValue = cachedHotWalletEth * cachedEthPriceUSD;
    const gasStatus =
      cachedHotWalletEth >= 0.001
        ? 'YETERLİ (Normal)'
        : cachedHotWalletEth > 0
          ? 'KRİTİK (Bakiye Ekleyiniz)'
          : 'Okunuyor...';

    body =
      `<b>[ARBITRUM AAVE V3 TASFİYE BOTU — YÖNETİM PANELİ]</b>\n` +
      `<b>Görünüm:</b> Cüzdan, Kasa ve Sözleşme Bilgileri\n` +
      `────────────────────────\n` +
      `<b>Sıcak İşlem Cüzdanı (Executor):</b>\n` +
      `<code>${account.address}</code>\n` +
      `<b>Canlı Gas Bakiyesi:</b> ${cachedHotWalletEth.toFixed(5)} ETH (~$${ethUsdValue.toFixed(2)})\n` +
      `<b>Gas Bakiye Durumu:</b> ${gasStatus}\n` +
      `<b>Sıradaki Nonce:</b> ${cachedNonce !== undefined ? cachedNonce : 'Senkronize ediliyor'}\n` +
      `────────────────────────\n` +
      `<b>Soğuk Kâr Kasası (Profit Recipient):</b>\n` +
      `<code>${cachedProfitRecipient}</code>\n` +
      `<b>Kasa Güvenlik Modu:</b> Ayrıştırılmış Soğuk Cüzdan (Aktif)\n` +
      `────────────────────────\n` +
      `<b>Aktif Tasfiye Sözleşmesi (v2):</b>\n` +
      `<code>${OUR_BOT_CONTRACT_ADDRESS}</code>\n` +
      `────────────────────────\n` +
      `<b>Son Güncelleme:</b> ${nowStr}`;
  }

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: tab === 'overview' ? '[ Genel Durum ]' : 'Genel Durum',
          callback_data: 'panel_overview'
        },
        {
          text: tab === 'borrowers' ? '[ Riskli Borçlular ]' : 'Riskli Borçlular',
          callback_data: 'panel_borrowers'
        }
      ],
      [
        {
          text: tab === 'liquidations' ? '[ Son Tasfiyeler ]' : 'Son Tasfiyeler',
          callback_data: 'panel_liquidations'
        },
        {
          text: tab === 'wallet' ? '[ Cüzdan ve Kasa ]' : 'Cüzdan ve Kasa',
          callback_data: 'panel_wallet'
        }
      ],
      [
        {
          text: 'Verileri Şimdi Yenile',
          callback_data: `refresh_${tab}`
        }
      ]
    ]
  };

  return { text: body, reply_markup };
}

function startTelegramControlPanel() {
  if (!telegramBotToken) {
    logInfo('Telegram Control Panel inactive (TELEGRAM_BOT_TOKEN is not set in .env).');
    return;
  }

  let botSelfId = '';

  (async () => {
    try {
      await callTelegramApi('deleteWebhook', { drop_pending_updates: false }, 8000);
      const me = await callTelegramApi('getMe', {}, 8000);
      if (me?.ok && me?.result) {
        botSelfId = String(me.result.id || '');
        if (activeTelegramChatId && activeTelegramChatId === botSelfId) {
          // Kullanıcı yanlışlıkla kendi ID'si yerine botun ID'sini yazdıysa sıfırla ki ilk mesajda gerçek ID otomatik algılansın
          activeTelegramChatId = '';
        }
        logInfo(
          `Telegram Bot connected: @${me.result.username} (ID: ${botSelfId}) | Waiting for /panel command...`
        );
      } else {
        logThrottledWarn(
          'tg_auth',
          `Telegram token rejected by API: ${me?.description || 'Invalid TELEGRAM_BOT_TOKEN'}`
        );
      }
      await callTelegramApi(
        'setMyCommands',
        {
          commands: [
            { command: 'panel', description: 'Yönetim ve izleme panelini aç' },
            { command: 'durum', description: 'Genel sistem durumu özeti' },
            { command: 'riskli', description: 'Yüksek riskli borçlular tablosu' },
            { command: 'tasfiyeler', description: 'Ağdaki son tasfiye işlemleri' },
            { command: 'cuzdan', description: 'Cüzdan, gas ve soğuk kasa bilgileri' }
          ]
        },
        8000
      );
    } catch {
      // Başlangıç kontrol hatasını geç
    }
  })();

  let updateOffset = 0;

  async function pollTelegramUpdates() {
    try {
      const data = await callTelegramApi(
        'getUpdates',
        { offset: updateOffset, timeout: 15 },
        22000
      );
      if (data?.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          updateOffset = upd.update_id + 1;

          if (upd.message) {
            const chatId = String(upd.message.chat?.id || '');
            if (!chatId) continue;

            if (!activeTelegramChatId) {
              activeTelegramChatId = chatId;
              logInfo(`Telegram authorized Chat ID automatically bound to: ${chatId}`);
            }

            const cmd = String(upd.message.text || '/panel').trim().toLowerCase();
            let initialTab: PanelTab = 'overview';
            if (cmd.startsWith('/riskli')) initialTab = 'borrowers';
            else if (cmd.startsWith('/tasfiyeler')) initialTab = 'liquidations';
            else if (cmd.startsWith('/cuzdan')) initialTab = 'wallet';

            const view = buildTelegramPanelView(initialTab);
            await callTelegramApi(
              'sendMessage',
              {
                chat_id: chatId,
                text: view.text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: view.reply_markup
              },
              8000
            );
          } else if (upd.callback_query) {
            const cb = upd.callback_query;
            const chatId = String(cb.message?.chat?.id || '');
            const messageId = cb.message?.message_id;
            if (!chatId || !messageId) continue;

            if (!activeTelegramChatId) {
              activeTelegramChatId = chatId;
            }

            const dataStr = String(cb.data || '');
            let targetTab: PanelTab = 'overview';
            if (dataStr.endsWith('borrowers')) targetTab = 'borrowers';
            else if (dataStr.endsWith('liquidations')) targetTab = 'liquidations';
            else if (dataStr.endsWith('wallet')) targetTab = 'wallet';

            const view = buildTelegramPanelView(targetTab);

            await Promise.allSettled([
              callTelegramApi(
                'editMessageText',
                {
                  chat_id: chatId,
                  message_id: messageId,
                  text: view.text,
                  parse_mode: 'HTML',
                  disable_web_page_preview: true,
                  reply_markup: view.reply_markup
                },
                8000
              ),
              callTelegramApi(
                'answerCallbackQuery',
                {
                  callback_query_id: cb.id,
                  text: 'Panel verileri güncellendi.'
                },
                5000
              )
            ]);
          }
        }
      }
    } catch {
      // Bağlantı zaman aşımında sessizce sonraki tura geç
    } finally {
      setTimeout(pollTelegramUpdates, 1000);
    }
  }

  pollTelegramUpdates();
  logInfo('Telegram Interactive Control Panel listener active (Zero-Spam Mode).');
}

async function main() {
  console.log('==================================================');
  console.log('[SYSTEM] HIGH-FREQUENCY LIQUIDATION SNIPER ENGINE ONLINE');
  console.log('==================================================');

  loadMonitoredUsers();
  // Telegram panelini RPC aramalarını beklemeden ilk saniyede başlat
  startTelegramControlPanel();
  await refreshExecutionParams();

  try {
    const currentRecipient = (await publicClient.readContract({
      address: OUR_BOT_CONTRACT_ADDRESS,
      abi: botContractAbi,
      functionName: 'profitRecipient'
    })) as `0x${string}`;
    cachedProfitRecipient = currentRecipient;
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
        cachedProfitRecipient = desiredRecipient;
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
  latestObservedBlock = currentBlock;
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
          latestObservedBlock = latestBlock;
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
            const liquidator = log.args?.liquidator || '';
            if (user && isAddress(user)) {
              const checksummed = getAddress(user);
              const inRadar = activeUsers.has(checksummed);
              const isOurBot =
                liquidator.toLowerCase() === OUR_BOT_CONTRACT_ADDRESS.toLowerCase() ||
                liquidator.toLowerCase() === account.address.toLowerCase();

              recentNetworkLiquidations.unshift({
                blockNumber: log.blockNumber || toBlock,
                txHash: log.transactionHash || '',
                user: checksummed,
                liquidator,
                inRadar,
                isOurBot,
                timestampMs: Date.now()
              });
              if (recentNetworkLiquidations.length > 15) {
                recentNetworkLiquidations.pop();
              }

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
        const errMsg = lastErr.shortMessage || lastErr.message || 'Unknown RPC error';
        logThrottledWarn(
          'poll_events',
          `Event polling failed across all RPCs: ${errMsg}`
        );
        sendTelegramAlert(
          'rpc_all_down',
          `<b>[KRİTİK SİSTEM UYARISI — RPC BAĞLANTI HATASI]</b>\n────────────────────────\n<b>Durum:</b> Tüm yedek RPC sunucularında olay taraması başarısız oldu.\n<b>Hata Detayı:</b> <code>${String(errMsg).slice(0, 160)}</code>\n<b>Sistem Tepkisi:</b> 10 saniye sonra otomatik yeniden denenecek.`,
          30 * 60 * 1000
        );
      }
    } finally {
      setTimeout(pollLiveEventsLoop, 10000);
    }
  }
  pollLiveEventsLoop();

  logInfo(
    `Starting Hybrid Multi-RPC & Private Sniper loops (WSS Block + Chainlink Oracle Trigger + QuoterV2 + 250ms / 2.5s / 15s). Monitoring ${activeUsers.size} addresses across ${AAVE_RESERVE_ASSETS.length} reserves.`
  );

  // Canlı WebSocket (WSS) Blok + Chainlink Oracle Fiyat Tetikleyicisi (Otomatik Yeniden Abonelik Korumalı)
  if (!process.env.LOCAL_FORK_URL) {
    let wsReconnecting = false;
    let unwatchBlock: (() => void) | null = null;
    let unwatchChainlink: (() => void) | null = null;

    const startRealtimeWebSocket = () => {
      try {
        if (unwatchBlock) {
          try { unwatchBlock(); } catch {}
          unwatchBlock = null;
        }
        if (unwatchChainlink) {
          try { unwatchChainlink(); } catch {}
          unwatchChainlink = null;
        }

        const wsClient = createPublicClient({
          chain: arbitrum,
          transport: webSocket(arbitrumWssUrl, { reconnect: true, keepAlive: true })
        });

        const handleWsDisconnect = (source: string, err: any) => {
          const shortMsg = (err?.shortMessage || err?.message || 'Socket closed').split('\n')[0];
          if ( wsReconnecting ) return;
          wsReconnecting = true;
          logInfo(`WebSocket (${source}) connection recycled (${shortMsg}). Re-subscribing in 3s...`);
          setTimeout(() => {
            wsReconnecting = false;
            startRealtimeWebSocket();
          }, 3000);
        };

        let lastWsSweep = 0;
        unwatchBlock = wsClient.watchBlockNumber({
          onBlockNumber: () => {
            const now = Date.now();
            if (imminentTargets.size > 0 && now - lastWsSweep >= 150) {
              lastWsSweep = now;
              checkUsersBatch(Array.from(imminentTargets), true, true).catch(() => {});
            }
          },
          onError: err => handleWsDisconnect('BlockWatcher', err)
        });

        // Chainlink AnswerUpdated Olay Tetikleyicisi: Fiyat değiştiği milisaniyede zamanlayıcıyı beklemeden tüm kritik hedefleri tarar
        if (chainlinkAggregators.length > 0) {
          let lastOracleSweep = 0;
          unwatchChainlink = wsClient.watchEvent({
            address: chainlinkAggregators,
            event: answerUpdatedEventAbi,
            poll: false,
            onLogs: logs => {
              if (logs.length === 0) return;
              lastValidOraclePrices = null; // Eski fiyat önbelleğini sıfırla
              const now = Date.now();
              if (now - lastOracleSweep < 100) return;
              lastOracleSweep = now;

              if (imminentTargets.size > 0) {
                checkUsersBatch(Array.from(imminentTargets), true, true).catch(() => {});
              }
              if (ultraCriticalTargets.size > 0) {
                const nonImminent = Array.from(ultraCriticalTargets).filter(
                  u => !imminentTargets.has(u)
                );
                if (nonImminent.length > 0) {
                  checkUsersBatch(nonImminent, true, false).catch(() => {});
                }
              }
            },
            onError: err => handleWsDisconnect('ChainlinkWatcher', err)
          });
        }
      } catch (err: any) {
        logThrottledWarn('wss_init', `Could not initialize WSS trigger: ${(err.message || '').split('\n')[0]}`);
      }
    };

    startRealtimeWebSocket();
    logInfo(
      `WebSocket Real-Time Block & Chainlink Oracle Trigger (${chainlinkAggregators.length} feeds) active on ${arbitrumWssUrl}`
    );
  }

  ultraCriticalSniperLoop();
  criticalSniperLoop();
  generalRadarLoop();
}

main().catch(err => {
  console.error(`[FATAL ERROR] ${err.message}`);
  sendTelegramAlert(
    'fatal_error',
    `<b>[KRİTİK SİSTEM UYARISI — MOTOR DURDU]</b>\n────────────────────────\n<b>Durum:</b> Ana tasfiye motorunda beklenmeyen bir hata oluştu.\n<b>Hata Detayı:</b> <code>${String(err.message || err).slice(0, 200)}</code>\n<b>Sistem Tepkisi:</b> PM2 tarafından otomatik yeniden başlatılacak.`,
    60000
  );
});
