// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Uniswap V3 Router Arayüzü (Hem Tekil Havuz hem Çok Adımlı Rota Desteği)
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

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract LiquidationBot is IFlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    // Arbitrum One Ana Köprü Varlıkları (Çok adımlı takas rotaları için)
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

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

    // Kârın aktarılacağı cüzdan adresini güncelleme (Sıcak/soğuk cüzdan ayrımı için)
    function setProfitRecipient(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "Invalid recipient");
        profitRecipient = _newRecipient;
    }

    // 1A. Geriye dönük uyumluluk: 4 parametreli çağrı
    function triggerLiquidation(
        address debtAsset,
        address collateralAsset,
        address userToLiquidate,
        uint256 debtToCover
    ) external onlyOwner {
        _executeLiquidation(debtAsset, collateralAsset, userToLiquidate, debtToCover, 500, 0);
    }

    // 1B. 5 parametreli çağrı (Havuz ücreti belirtmeli)
    function triggerLiquidation(
        address debtAsset,
        address collateralAsset,
        address userToLiquidate,
        uint256 debtToCover,
        uint24 poolFee
    ) external onlyOwner {
        _executeLiquidation(debtAsset, collateralAsset, userToLiquidate, debtToCover, poolFee == 0 ? 500 : poolFee, 0);
    }

    // 1C. 6 parametreli tam korumalı çağrı (Havuz ücreti + Minimum Net Kâr garantisi)
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

        pool.flashLoanSimple(
            address(this),
            debtAsset,
            debtToCover,
            params,
            0
        );

        // Flaş kredi geri ödendikten sonra sözleşmede kalan tüm debtAsset net kârımızdır
        uint256 profit = IERC20(debtAsset).balanceOf(address(this));
        if (profit > 0) {
            IERC20(debtAsset).safeTransfer(profitRecipient, profit);
        }
    }

    // Tekil havuz denemesi (Başarısız olursa veya minimum çıktıyı karşılamazsa false döner)
    function _trySingleSwap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (bool) {
        try
            swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            )
        returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    // Çok adımlı (2-Hop) takas denemesi: tokenIn -> midToken -> tokenOut
    function _tryMultiHopSwap(
        address tokenIn,
        uint24 fee1,
        address midToken,
        uint24 fee2,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (bool) {
        if (tokenIn == midToken || tokenOut == midToken) return false;
        try
            swapRouter.exactInput(
                ISwapRouter.ExactInputParams({
                    path: abi.encodePacked(tokenIn, fee1, midToken, fee2, tokenOut),
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum
                })
            )
        returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    // Otomatik Çoklu Havuz ve Çok Adımlı (WETH / USDC Köprülü) Takas Motoru
    function _swapCollateralForDebt(
        address collateralAsset,
        address debtAsset,
        uint24 preferredFee,
        uint256 collateralAmount,
        uint256 requiredAmountOut
    ) internal {
        // 1. Öncelikli tekil havuz (Örn: 500)
        if (_trySingleSwap(collateralAsset, debtAsset, preferredFee, collateralAmount, requiredAmountOut)) return;

        // 2. Alternatif tekil havuzlar (3000 = %0.30, 100 = %0.01, 500 = %0.05, 10000 = %1.00)
        if (preferredFee != 3000 && _trySingleSwap(collateralAsset, debtAsset, 3000, collateralAmount, requiredAmountOut)) return;
        if (preferredFee != 100 && _trySingleSwap(collateralAsset, debtAsset, 100, collateralAmount, requiredAmountOut)) return;
        if (preferredFee != 500 && _trySingleSwap(collateralAsset, debtAsset, 500, collateralAmount, requiredAmountOut)) return;
        if (preferredFee != 10000 && _trySingleSwap(collateralAsset, debtAsset, 10000, collateralAmount, requiredAmountOut)) return;

        // 3. WETH üzerinden 2 adımlı (Multi-Hop) rotalar (Örn: ARB/LINK/wstETH/weETH -> WETH -> USDC/USDT/DAI/GHO)
        if (_tryMultiHopSwap(collateralAsset, 500, WETH, 500, debtAsset, collateralAmount, requiredAmountOut)) return;
        if (_tryMultiHopSwap(collateralAsset, 3000, WETH, 500, debtAsset, collateralAmount, requiredAmountOut)) return;
        if (_tryMultiHopSwap(collateralAsset, 100, WETH, 500, debtAsset, collateralAmount, requiredAmountOut)) return;
        if (_tryMultiHopSwap(collateralAsset, 500, WETH, 3000, debtAsset, collateralAmount, requiredAmountOut)) return;
        if (_tryMultiHopSwap(collateralAsset, 3000, WETH, 3000, debtAsset, collateralAmount, requiredAmountOut)) return;

        // 4. Native USDC üzerinden 2 adımlı (Multi-Hop) rotalar
        if (_tryMultiHopSwap(collateralAsset, 500, USDC, 100, debtAsset, collateralAmount, requiredAmountOut)) return;
        if (_tryMultiHopSwap(collateralAsset, 500, USDC, 500, debtAsset, collateralAmount, requiredAmountOut)) return;
        if (_tryMultiHopSwap(collateralAsset, 100, USDC, 500, debtAsset, collateralAmount, requiredAmountOut)) return;

        revert("All swap routes failed or insufficient output");
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

        // c) Geri ödenecek toplam borç + minimum kâr hedefini hesapla ve takas et
        uint256 totalDebt = amount + premium;
        uint256 targetBalance = totalDebt + data.minProfit;
        {
            uint256 collateralReceived = IERC20(data.collateralAsset).balanceOf(address(this));
            require(collateralReceived > 0, "No collateral received");

            uint256 unspentAsset = IERC20(asset).balanceOf(address(this));
            uint256 requiredAmountOut = targetBalance > unspentAsset ? (targetBalance - unspentAsset) : 0;

            IERC20(data.collateralAsset).forceApprove(address(swapRouter), collateralReceived);

            _swapCollateralForDebt(
                data.collateralAsset,
                asset,
                data.poolFee,
                collateralReceived,
                requiredAmountOut
            );
        }

        // d) Nihai bakiye kontrolü (Anapara + Faiz + Minimum Kâr garantisi)
        require(IERC20(asset).balanceOf(address(this)) >= targetBalance, "Not profitable! Reverting...");

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
