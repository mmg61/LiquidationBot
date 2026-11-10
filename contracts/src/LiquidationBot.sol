// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
    using SafeERC20 for IERC20;

    IPoolAddressesProvider public immutable addressProvider;
    IPool public immutable pool;
    ISwapRouter public immutable swapRouter;
    address public owner;
    address public profitRecipient;

    // Flash Loan'dan gelen parametreleri tutmak için geçici yapı
    struct FlashData {
        address collateralAsset;
        address userToLiquidate;
        uint256 debtToCover;
        uint24 poolFee;
        uint256 minProfit;
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
        profitRecipient = msg.sender;
    }

    // Kârın aktarılacağı soğuk cüzdan adresini güncelleme (İsteğe bağlı güvenlik ayrımı)
    function setProfitRecipient(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "Invalid recipient");
        profitRecipient = _newRecipient;
    }

    // 1A. Geriye dönük uyumluluk: Varsayılan 500 (%0.05 Arbitrum ana havuzu) ile tasfiye tetikleme
    function triggerLiquidation(
        address debtAsset,
        address collateralAsset,
        address userToLiquidate,
        uint256 debtToCover
    ) external onlyOwner {
        _executeLiquidation(debtAsset, collateralAsset, userToLiquidate, debtToCover, 500, 0);
    }

    // 1B. Dinamik havuz komisyonu (Örn: 500, 3000) belirterek tasfiye tetikleme
    function triggerLiquidation(
        address debtAsset,
        address collateralAsset,
        address userToLiquidate,
        uint256 debtToCover,
        uint24 poolFee
    ) external onlyOwner {
        _executeLiquidation(debtAsset, collateralAsset, userToLiquidate, debtToCover, poolFee == 0 ? 500 : poolFee, 0);
    }

    // 1C. Dinamik havuz komisyonu ve minimum net kâr (minProfit) garantisi ile tasfiye tetikleme
    function triggerLiquidation(
        address debtAsset,
        address collateralAsset,
        address userToLiquidate,
        uint256 debtToCover,
        uint24 poolFee,
        uint256 minProfit
    ) external onlyOwner {
        _executeLiquidation(debtAsset, collateralAsset, userToLiquidate, debtToCover, poolFee == 0 ? 500 : poolFee, minProfit);
    }

    // Flaş kredi talep eden ve kâr aktarımını yöneten ortak iç fonksiyon
    function _executeLiquidation(
        address debtAsset,
        address collateralAsset,
        address userToLiquidate,
        uint256 debtToCover,
        uint24 poolFee,
        uint256 minProfit
    ) internal {
        bytes memory params = abi.encode(
            FlashData({
                collateralAsset: collateralAsset,
                userToLiquidate: userToLiquidate,
                debtToCover: debtToCover,
                poolFee: poolFee,
                minProfit: minProfit
            })
        );

        // Aave'den Flaş Kredi (Flash Loan) İsteği
        pool.flashLoanSimple(
            address(this),
            debtAsset,
            debtToCover,
            params,
            0
        );

        // --- KÂRI ANINDA CÜZDANA AKTARMA ---
        // Flaş kredi geri ödendikten sonra sözleşmede kalan debtAsset net kârımızdır.
        uint256 profit = IERC20(debtAsset).balanceOf(address(this));
        if (profit > 0) {
            IERC20(debtAsset).safeTransfer(profitRecipient, profit);
        }
    }

    // 2. Flaş kredi geldiğinde Aave otomatik olarak bu fonksiyonu tetikler
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(pool), "Caller must be Aave Pool");
        require(initiator == address(this), "Initiator must be this contract");

        FlashData memory data = abi.decode(params, (FlashData));

        // a) Kredi alınan parayı kullanarak batık kullanıcının borcunu öde ve teminatı satın al
        IERC20(asset).forceApprove(address(pool), amount);
        pool.liquidationCall(
            data.collateralAsset,
            asset,
            data.userToLiquidate,
            amount,
            false
        );

        // b) Elde edilen teminatı borsada sat (Uniswap V3)
        uint256 collateralReceived = IERC20(data.collateralAsset).balanceOf(address(this));
        require(collateralReceived > 0, "No collateral received");

        IERC20(data.collateralAsset).forceApprove(address(swapRouter), collateralReceived);

        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: data.collateralAsset,
            tokenOut: asset,
            fee: data.poolFee,
            recipient: address(this),
            deadline: block.timestamp + 100,
            amountIn: collateralReceived,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        swapRouter.exactInputSingle(swapParams);

        // c) Borcu geri öde (Miktar + Flaş Kredi Faizi + Minimum Kâr)
        // Aave borcun tamamını kullanmadıysa sözleşmede kalan artan bakiye + takastan gelen toplam bakiye kontrol edilir.
        uint256 totalDebt = amount + premium;
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        require(finalBalance >= totalDebt + data.minProfit, "Not profitable! Reverting...");

        IERC20(asset).forceApprove(address(pool), totalDebt);

        return true;
    }

    function ADDRESSES_PROVIDER() external view override returns (IPoolAddressesProvider) {
        return addressProvider;
    }

    function POOL() external view override returns (IPool) {
        return pool;
    }

    function withdraw(address token) external onlyOwner {
        require(token != address(0), "Invalid token address");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(profitRecipient, balance);
        }
    }

    function withdrawETH() external onlyOwner {
        payable(profitRecipient).transfer(address(this).balance);
    }

    receive() external payable {}
}
