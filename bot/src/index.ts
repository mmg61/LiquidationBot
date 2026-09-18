import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, localhost } from 'viem/chains';
import * as dotenv from 'dotenv';

dotenv.config();

const rpcUrl = process.env.LOCAL_FORK_URL || process.env.ARBITRUM_RPC_URL || 'http://127.0.0.1:8545';
const privateKey = process.env.PRIVATE_KEY;

if (!privateKey) {
  console.error("[ERROR] PRIVATE_KEY not found in .env file.");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey.startsWith('0x') ? (privateKey as `0x${string}`) : `0x${privateKey}`);
const chainToUse = process.env.LOCAL_FORK_URL ? localhost : arbitrum;

const publicClient = createPublicClient({ chain: chainToUse, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: chainToUse, transport: http(rpcUrl) });

const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as const;
const OUR_BOT_CONTRACT_ADDRESS = (process.env.BOT_CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`;

const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; 
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'; 

const getUserAccountDataAbi = parseAbiItem('function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)');
const borrowEventAbi = parseAbiItem('event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)');
const botContractAbi = parseAbi([
  'function triggerLiquidation(address debtAsset, address collateralAsset, address userToLiquidate, uint256 debtToCover) external'
]);

// Veritabanı (Radarımızdaki Kullanıcılar)
const activeUsers = new Set<`0x${string}`>();
// Tekrarlanan işlemleri engellemek için soğuma süresi (Cooldown)
const cooldowns = new Map<string, number>();

function logInfo(message: string) { console.log(`[INFO] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }
function logAlert(message: string) { console.log(`[ALERT] ${new Date().toISOString().split('T')[1].slice(0,-1)} - ${message}`); }

async function checkUser(userAddress: `0x${string}`) {
  const now = Date.now();
  if (cooldowns.has(userAddress) && now < cooldowns.get(userAddress)!) return;

  try {
    const data = await publicClient.readContract({
      address: AAVE_POOL_ADDRESS,
      abi: [getUserAccountDataAbi],
      functionName: 'getUserAccountData',
      args: [userAddress]
    }) as [bigint, bigint, bigint, bigint, bigint, bigint];
    
    const healthFactor = Number(data[5]) / 1e18;
    const totalDebtUSD = Number(data[1]) / 1e8; 

    if (healthFactor > 0 && healthFactor < 1.0) {
      logAlert(`TARGET ACQUIRED | User: ${userAddress} | HF: ${healthFactor.toFixed(4)} | Debt: $${totalDebtUSD.toFixed(2)}`);
      
      // Cooldown ekle (Aynı kullanıcıya 2 dakika boyunca bir daha bakma, spam'i önle)
      cooldowns.set(userAddress, now + 120000);

      const debtToCover = 10000000n; // 10 USDC (Şimdilik test limiti)
      logInfo(`Simulating liquidation transaction...`);
      
      try {
        const { request } = await publicClient.simulateContract({
          address: OUR_BOT_CONTRACT_ADDRESS,
          abi: botContractAbi,
          functionName: 'triggerLiquidation',
          args: [USDC, WETH, userAddress, debtToCover],
          account: account
        });

        logInfo(`Simulation passed. Broadcasting transaction...`);
        const txHash = await walletClient.writeContract(request);
        logInfo(`Transaction broadcasted! Hash: ${txHash}`);
      } catch (simError: any) {
        const errorMessage = simError.shortMessage || simError.message.split('\n')[0];
        logInfo(`Simulation reverted (Gas saved): ${errorMessage}`);
      }
    } else if (totalDebtUSD === 0) {
      // Kullanıcının borcu kalmadıysa radardan çıkar (Sistemi hafifletmek için)
      activeUsers.delete(userAddress);
    }
  } catch (error) {
    // Hata yönetimi (RPC rate limit vb. için sessiz geç)
  }
}

// Ana Radar Döngüsü (Sürekli tarama yapar)
async function radarLoop() {
  if (activeUsers.size > 0) {
    logInfo(`Radar Sweep: Scanning ${activeUsers.size} active users for price-drop liquidations...`);
    // Sistem yorulmasın diye paralel sorgular atıyoruz
    const promises = Array.from(activeUsers).map(user => checkUser(user));
    await Promise.allSettled(promises);
  }
  
  // Her 15 Saniyede bir tüm radarı baştan sona tara
  setTimeout(radarLoop, 15000);
}

async function main() {
  console.log("==================================================");
  console.log("LIQUIDATION ENGINE: ACTIVE RADAR MODE INITIATED");
  console.log("==================================================");
  
  const currentBlock = await publicClient.getBlockNumber();
  logInfo(`Connected to network. Current Block: ${currentBlock}`);

  // 1. Geçmiş Blokları Parçalar (Chunks) Halinde Tara (RPC Limitini Aşmak İçin)
  const LOOKBACK = 10000n;
  const CHUNK = 2000n;
  logInfo(`Fetching historical borrowers from the last ${LOOKBACK} blocks in chunks to build watchlist...`);
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
      // Alchemy rate limitine takılmamak için parçalar arası yarım saniye mola
      await new Promise(r => setTimeout(r, 500));
    }
    logInfo(`History scan complete. Added ${activeUsers.size} unique users to radar.`);
  } catch (e) {
    logInfo(`Chunked history scan failed. Starting with empty radar.`);
  }

  // 2. Canlı Olarak Yeni Borç Alanları Radara Ekle
  publicClient.watchEvent({
    address: AAVE_POOL_ADDRESS,
    event: borrowEventAbi,
    onLogs: logs => {
      logs.forEach(log => {
        const user = log.args?.user;
        if (user) {
          if (!activeUsers.has(user as `0x${string}`)) {
            activeUsers.add(user as `0x${string}`);
            logInfo(`New borrower detected on-chain. Added to radar: ${user}`);
          }
        }
      });
    }
  });

  // 3. Radar Döngüsünü Başlat
  radarLoop();
}

main().catch(err => console.error(`[FATAL ERROR] ${err.message}`));
