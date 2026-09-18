import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, localhost } from 'viem/chains';
import * as dotenv from 'dotenv';

// Çevresel değişkenleri (Environment Variables) yükler.
dotenv.config();

// ==========================================
// 1. AĞ VE CÜZDAN KONFİGÜRASYONU
// ==========================================
// RPC URL: Blockchain ağına bağlantı noktasıdır. .env dosyasından okunur.
const rpcUrl = process.env.LOCAL_FORK_URL || process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';

// İşlemleri imzalamak için kullanılacak cüzdanın özel anahtarı (Private Key).
const privateKey = process.env.PRIVATE_KEY;

if (!privateKey) {
  console.error("[ERROR] PRIVATE_KEY not found in .env file.");
  process.exit(1);
}

// Özel anahtarı Viem cüzdan formatına dönüştürür.
const account = privateKeyToAccount(privateKey.startsWith('0x') ? (privateKey as `0x${string}`) : `0x${privateKey}`);
const chainToUse = process.env.LOCAL_FORK_URL ? localhost : arbitrum;

// Sadece veri okuma (Read) işlemleri için yapılandırılmış istemci.
const publicClient = createPublicClient({ chain: chainToUse, transport: http(rpcUrl) });
// Veri yazma (Write) ve işlem imzalama işlemleri için yapılandırılmış istemci.
const walletClient = createWalletClient({ account, chain: chainToUse, transport: http(rpcUrl) });


// ==========================================
// 2. AKILLI SÖZLEŞME VE TOKEN ADRESLERİ
// ==========================================
const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const; // Aave V3 Arbitrum Ana Havuzu
const OUR_BOT_CONTRACT_ADDRESS = (process.env.BOT_CONTRACT_ADDRESS) as `0x${string}`; // Dağıtımı yapılmış (Deployed) Tasfiye Sözleşmesi

const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // Borç ödenecek baz varlık (Debt Asset)
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'; // Teminat olarak alınacak varlık (Collateral Asset)

// Aave havuzundan veri okumak için gerekli fonksiyonların ABI tanımları.
const getUserAccountDataAbi = parseAbiItem('function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)');
const borrowEventAbi = parseAbiItem('event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)');
const botContractAbi = parseAbi([
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover) external'
]);


// ==========================================
// 3. İZLEME VERİTABANI VE DURUM YÖNETİMİ
// ==========================================
// activeUsers: Ağda tespit edilen ve sağlık faktörü izlenecek olan kullanıcı adreslerinin tutulduğu benzersiz küme.
const activeUsers = new Set<`0x${string}`>();

// cooldowns: Aşırı sorgu (rate limit) sorunlarını önlemek amacıyla, yakın zamanda işlem veya simülasyon yapılmış adreslerin bekleme süresi kaydı.
const cooldowns = new Map<string, number>();

function logInfo(message: string) { console.log(`[INFO] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }
function logAlert(message: string) { console.log(`[ALERT] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }


// ==========================================
// 4. KULLANICI SAĞLIK KONTROLÜ VE TASFİYE (LIQUIDATION)
// ==========================================
// Belirtilen kullanıcının Aave üzerindeki pozisyon sağlığını kontrol eder.
async function checkUser(userAddress: `0x${string}`) {
  const now = Date.now();
  // Bekleme süresi (cooldown) devam eden kullanıcıları atla.
  if (cooldowns.has(userAddress) && now < cooldowns.get(userAddress)!) return;

  try {
    // Kullanıcının anlık borç ve teminat verilerini okur.
    const data = await publicClient.readContract({
      address: AAVE_POOL_ADDRESS,
      abi: [getUserAccountDataAbi],
      functionName: 'getUserAccountData',
      args: [userAddress]
    }) as [bigint, bigint, bigint, bigint, bigint, bigint];
    
    // Sağlık faktörü (Health Factor) hesaplaması. 1.0'ın altı tasfiye edilebilir durumdadır.
    const healthFactor = Number(data[5]) / 1e18;
    const totalDebtUSD = Number(data[1]) / 1e8; 

    // TASFİYE KOŞULU SAĞLANDI
    if (healthFactor > 0 && healthFactor < 1.0) {
      logAlert(`LIQUIDATION CONDITION MET | Address: ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`);
      
      // Aynı adrese tekrarlı simülasyon/işlem atılmasını önlemek için 2 dakikalık bekleme süresi atanır.
      cooldowns.set(userAddress, now + 120000);

      // KULLANICININ GERÇEK USDC BORCUNU SORGULAMA VE %50'SİNİ HESAPLAMA
      const usdcDebtAbi = parseAbiItem('function balanceOf(address user) view returns (uint256)');
      const USDC_VARIABLE_DEBT_TOKEN = '0x72aD9701Ce8260c57173EE8D84C1CDBFbe0a4A01' as const; // Aave V3 Arbitrum USDC Debt Token
      
      const userUsdcDebt = await publicClient.readContract({
        address: USDC_VARIABLE_DEBT_TOKEN,
        abi: [usdcDebtAbi],
        functionName: 'balanceOf',
        args: [userAddress]
      }) as bigint;

      if (userUsdcDebt === 0n) {
         logInfo(`User has no USDC debt. Skipping...`);
         return;
      }

      // Aave V3 kuralı: Kapatma faktörü (Close Factor) maksimum %50'dir. Bu yüzden borcun tam yarısını tasfiye ediyoruz.
      const debtToCover = userUsdcDebt / 2n; 
      
      logInfo(`Initiating transaction simulation for covering ${Number(debtToCover) / 1e6} USDC debt...`);
      
      try {
        // İşlem ağa gönderilmeden önce simüle edilir. Beklenen kâr elde edilemiyorsa (örn: yüksek gas, yetersiz likidite) simülasyon başarısız olur ve işlem maliyetinden tasarruf edilir.
        const { request } = await publicClient.simulateContract({
          address: OUR_BOT_CONTRACT_ADDRESS,
          abi: botContractAbi,
          functionName: 'triggerLiquidation',
          args: [USDC, WETH, userAddress, debtToCover],
          account: account
        });

        // Simülasyon başarılıysa işlem ağa yayınlanır.
        logInfo(`Simulation passed. Broadcasting transaction...`);
        const txHash = await walletClient.writeContract(request);
        logInfo(`Transaction successfully broadcasted. Hash: ${txHash}`);
      } catch (simError: any) {
        // Simülasyonun reddedilmesi durumunda loglanır.
        const errorMessage = simError.shortMessage || simError.message.split('\n')[0];
        logInfo(`Simulation reverted. Operation aborted. Reason: ${errorMessage}`);
      }
    } else if (totalDebtUSD === 0) {
      // Kullanıcının borcu tamamen kapandıysa izleme listesinden çıkarılır.
      activeUsers.delete(userAddress);
    }
  } catch (error) {
    // RPC okuma hataları göz ardı edilir (Geçici bağlantı sorunları veya rate limitler için).
  }
}


// ==========================================
// 5. İZLEME DÖNGÜSÜ (Monitoring Loop)
// ==========================================
// İzleme listesindeki tüm adreslerin sağlık durumlarını periyodik olarak kontrol eder.
async function radarLoop() {
  if (activeUsers.size > 0) {
    logInfo(`Executing health factor sweep across ${activeUsers.size} monitored addresses...`);
    // Listedeki adresler için asenkron kontroller başlatılır.
    const promises = Array.from(activeUsers).map(user => checkUser(user));
    await Promise.allSettled(promises);
  }
  
  // 15 saniye aralıklarla döngü tekrar eder.
  setTimeout(radarLoop, 15000);
}


// ==========================================
// 6. ANA BAŞLATMA FONKSİYONU
// ==========================================
async function main() {
  console.log("==================================================");
  console.log("[SYSTEM] LIQUIDATION ENGINE INITIALIZED");
  console.log("==================================================");
  
  const currentBlock = await publicClient.getBlockNumber();
  logInfo(`Connected to network. Current Block: ${currentBlock}`);

  // ADIM 1: Geçmiş bloklardaki borçlanma olaylarını tarayarak ilk izleme listesini oluşturur.
  const LOOKBACK = 10000n;
  const CHUNK = 2000n;
  logInfo(`Synchronizing historical borrower data (Last ${LOOKBACK} blocks)...`);
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
        if (log.args.user) activeUsers.add(log.args.user as `0x${string}`);
      });
      // RPC oran limitlerine (rate limit) takılmamak için gecikme eklenir.
      await new Promise(r => setTimeout(r, 500));
    }
    logInfo(`Synchronization complete. Monitored addresses: ${activeUsers.size}`);
  } catch (e) {
    logInfo(`Historical synchronization rate-limited. Proceeding with active listener only.`);
  }

  // ADIM 2: Canlı ağdaki yeni borçlanma olaylarını dinler ve izleme listesine ekler.
  publicClient.watchEvent({
    address: AAVE_POOL_ADDRESS,
    event: borrowEventAbi,
    onLogs: logs => {
      logs.forEach(log => {
        const user = log.args?.user;
        if (user) {
          if (!activeUsers.has(user as `0x${string}`)) {
            activeUsers.add(user as `0x${string}`);
            logInfo(`New borrower detected. Address added to monitoring list: ${user}`);
          }
        }
      });
    }
  });

  // ADIM 3: İzleme döngüsünü başlatır.
  radarLoop();
}

main().catch(err => console.error(`[FATAL ERROR] ${err.message}`));
