// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Uniswap V3 Router Arayüzü (Teminatı satıp borcu kapatmak için)
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract LiquidationBot is IFlashLoanSimpleReceiver {
    IPoolAddressesProvider public immutable addressProvider;
    IPool public immutable pool;
    ISwapRouter public immutable swapRouter;
    address public owner;

    // Flash Loan'dan gelen parametreleri tutmak için geçici yapı
    struct FlashData {
        address collateralAsset;
        address userToLiquidate;
        uint256 debtToCover;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call");
        _;
    }

    constructor(address _addressProvider, address _swapRouter) {
        addressProvider = IPoolAddressesProvider(_addressProvider);
        pool = IPool(addressProvider.getPool());
        swapRouter = ISwapRouter(_swapRouter);
        owner = msg.sender;
    }

    function triggerLiquidation(
        address debtAsset, // Flaş kredi olarak alınacak token (Örn: USDC)
        address collateralAsset, // Satın alınacak indirimli teminat (Örn: WETH)
        address userToLiquidate, // Tasfiye edilecek kullanıcının adresi
        uint256 debtToCover // Ödenecek borç miktarı
    ) external onlyOwner {
        // Flash Loan talep ederken executeOperation'a iletmek için veriyi kodluyoruz
        bytes memory params = abi.encode(
            FlashData({
                collateralAsset: collateralAsset,
                userToLiquidate: userToLiquidate,
                debtToCover: debtToCover
            })
        );

        // 1. Aave'den Flaş Kredi (Flash Loan) İsteği ve İşlemler
        pool.flashLoanSimple(
            address(this), // Krediyi alan (bu sözleşme)
            debtAsset, // Kredi alınacak token
            debtToCover, // Kredi miktarı
            params, // Kredi alındığında çalışacak fonksiyona geçirilecek ekstra veri
            0 // Referral Code
        );

        // --- YENİ GÜNCELLEME: KÂRI ANINDA CÜZDANA AKTARMA ---
        // Üstteki flashLoanSimple satırı tamamlandığında, bot işlemleri yapmış ve Aave borcunu otomatik tahsil etmiştir.
        // Sözleşmenin içinde kalan debtAsset (Örn: USDC) bizim net kârımızdır.
        uint256 profit = IERC20(debtAsset).balanceOf(address(this));
        if (profit > 0) {
            IERC20(debtAsset).transfer(owner, profit); // Kârı anında Owner'a (MetaMask cüzdanınıza) gönderir!
        }
    }

    // 2. Flaş kredi geldiğinde Aave otomatik olarak bu fonksiyonu tetikler
    function executeOperation(
        address asset, // Kredi alınan token (debtAsset)
        uint256 amount, // Kredi alınan miktar
        uint256 premium, // Aave'ye ödenecek faiz ücreti
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Sadece Aave Pool'u bu fonksiyonu çağırabilir
        require(msg.sender == address(pool), "Caller must be Aave Pool");
        require(initiator == address(this), "Initiator must be this contract");

        // Kodlanmış veriyi çöz
        FlashData memory data = abi.decode(params, (FlashData));

        // a) Kredi alınan parayı kullanarak batık kullanıcının borcunu öde ve teminatı satın al
        IERC20(asset).approve(address(pool), amount);
        pool.liquidationCall(
            data.collateralAsset,
            asset,
            data.userToLiquidate,
            amount,
            false // aToken olarak mı almak istiyoruz? Hayır, doğrudan underlying token istiyoruz.
        );

        // b) Elde edilen teminatı borsada sat (Uniswap V3)
        uint256 collateralReceived = IERC20(data.collateralAsset).balanceOf(address(this));
        require(collateralReceived > 0, "No collateral received");

        IERC20(data.collateralAsset).approve(address(swapRouter), collateralReceived);

        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: data.collateralAsset,
            tokenOut: asset,
            fee: 3000, // 0.3% havuz komisyon oranı (örnek)
            recipient: address(this),
            deadline: block.timestamp + 100,
            amountIn: collateralReceived,
            amountOutMinimum: 0, // Gerçek hayatta MEV koruması için hesaplanmalı
            sqrtPriceLimitX96: 0
        });

        uint256 amountOut = swapRouter.exactInputSingle(swapParams);

        // c) Borcu geri öde (Miktar + Flaş Kredi Faizi)
        uint256 totalDebt = amount + premium;
        require(amountOut >= totalDebt, "Not profitable! Reverting...");

        IERC20(asset).approve(address(pool), totalDebt);

        return true; // true dönersek Aave paramızı çeker ve işlemi onaylar.
    }

    // Aave V3 adresi sözleşmesi standart arayüz gereği
    function ADDRESSES_PROVIDER() external view override returns (IPoolAddressesProvider) {
        return addressProvider;
    }

    // Aave V3 Pool adresi
    function POOL() external view override returns (IPool) {
        return pool;
    }

    // Kalan kârı sahibin cüzdanına çekmek için
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, balance);
    }

    // Yanlışlıkla gönderilen ETH'leri çekmek için
    function withdrawETH() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    receive() external payable {}
}
