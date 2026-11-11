// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {Test, console2} from "forge-std/Test.sol";
import {LiquidationBot, ISwapRouter} from "../src/LiquidationBot.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPoolAddressesProvider {
    address public pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

contract MockAavePool {
    uint256 public actualDebtUsedRatioBps = 10000; // 100% by default; can be <10000 to simulate Aave capping debtToCover
    uint256 public collateralRewardAmount;

    function setLiquidationBehavior(uint256 _usedRatioBps, uint256 _collateralReward) external {
        actualDebtUsedRatioBps = _usedRatioBps;
        collateralRewardAmount = _collateralReward;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        uint256 premium = (amount * 5) / 10000; // 0.05% Aave V3 flashloan fee
        MockERC20(asset).mint(receiverAddress, amount);

        bool ok = IFlashLoanSimpleReceiver(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            receiverAddress,
            params
        );
        require(ok, "FlashLoan executeOperation returned false");

        uint256 totalDebt = amount + premium;
        MockERC20(asset).transferFrom(receiverAddress, address(this), totalDebt);
    }

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address,
        uint256 debtToCover,
        bool
    ) external {
        uint256 actualDebtTaken = (debtToCover * actualDebtUsedRatioBps) / 10000;
        MockERC20(debtAsset).transferFrom(msg.sender, address(this), actualDebtTaken);
        MockERC20(collateralAsset).mint(msg.sender, collateralRewardAmount);
    }
}

contract MockSwapRouter {
    bool public revertFee500;
    bool public revertAllSingleHop;
    uint256 public simulatedAmountOut;

    function setRoutingMode(bool _revertFee500, bool _revertAllSingleHop, uint256 _simulatedAmountOut) external {
        revertFee500 = _revertFee500;
        revertAllSingleHop = _revertAllSingleHop;
        simulatedAmountOut = _simulatedAmountOut;
    }

    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params) external payable returns (uint256) {
        if (revertAllSingleHop) revert("Single-hop pool missing");
        if (revertFee500 && params.fee == 500) revert("500 bps pool missing");
        require(simulatedAmountOut >= params.amountOutMinimum, "Too little received");

        MockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        MockERC20(params.tokenOut).mint(params.recipient, simulatedAmountOut);
        return simulatedAmountOut;
    }

    function exactInput(ISwapRouter.ExactInputParams calldata params) external payable returns (uint256) {
        require(simulatedAmountOut >= params.amountOutMinimum, "Too little received");
        // Strictly validate 2-hop packed path: tokenIn (20B) + fee1 (3B) + bridge (20B) + fee2 (3B) + tokenOut (20B) = 66 bytes
        bytes memory path = params.path;
        require(path.length == 66, "Invalid 2-hop path length");

        address tokenIn;
        uint24 fee1;
        address bridge;
        uint24 fee2;
        address tokenOut;
        assembly {
            tokenIn := shr(96, mload(add(path, 32)))
            fee1 := shr(232, mload(add(path, 52)))
            bridge := shr(96, mload(add(path, 55)))
            fee2 := shr(232, mload(add(path, 75)))
            tokenOut := shr(96, mload(add(path, 78)))
        }

        require(
            bridge == 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 ||
            bridge == 0xaf88d065e77c8cC2239327C5EDb3A432268e5831,
            "Invalid intermediate bridge token"
        );
        require(fee1 == 500 || fee1 == 3000, "Invalid fee1 tier");
        require(fee2 == 500 || fee2 == 3000, "Invalid fee2 tier");

        MockERC20(tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        MockERC20(tokenOut).mint(params.recipient, simulatedAmountOut);
        return simulatedAmountOut;
    }
}

contract LiquidationBotTest is Test {
    MockERC20 public debtToken;
    MockERC20 public collateralToken;
    MockAavePool public pool;
    MockPoolAddressesProvider public provider;
    MockSwapRouter public router;
    LiquidationBot public bot;

    address public borrower = address(0xBEEF);
    address public coldProfitWallet = address(0xCAFE);

    function setUp() public {
        debtToken = new MockERC20("Tether USD", "USDT", 6);
        collateralToken = new MockERC20("Arbitrum", "ARB", 18);
        pool = new MockAavePool();
        provider = new MockPoolAddressesProvider(address(pool));
        router = new MockSwapRouter();

        bot = new LiquidationBot(address(provider), address(router));
        bot.setProfitRecipient(coldProfitWallet);
    }

    function test_RevertWhen_ProfitBelowMinProfit() public {
        // Debt = 1,000 USDT, FlashLoan Premium = 0.5 USDT -> Total Debt = 1,000.5 USDT
        // Swap returns 1,005 USDT (Net profit = 4.5 USDT)
        pool.setLiquidationBehavior(10000, 500 ether);
        router.setRoutingMode(false, false, 1_005_000_000); // 1005 USDT

        // Require minProfit = 10 USDT -> must revert at amountOutMinimum / minProfit check
        vm.expectRevert(bytes("All swap routes failed or insufficient output"));
        bot.triggerLiquidation(
            address(debtToken),
            address(collateralToken),
            borrower,
            1_000_000_000,
            500,
            10_000_000
        );
    }

    function test_Success_FeeTierFallback_From500To3000() public {
        // 500 fee pool reverts, 3000 fee pool succeeds with 1,020 USDT output
        pool.setLiquidationBehavior(10000, 500 ether);
        router.setRoutingMode(true, false, 1_020_000_000);

        bot.triggerLiquidation(
            address(debtToken),
            address(collateralToken),
            borrower,
            1_000_000_000,
            500,
            5_000_000 // 5 USDT minProfit
        );

        // Total debt = 1000.5 USDT, Output = 1020 USDT -> Net Profit = 19.5 USDT sent to coldProfitWallet
        assertEq(debtToken.balanceOf(coldProfitWallet), 19_500_000);
    }

    function test_Success_MultiHopFallback_WhenAllSingleHopPoolsFail() public {
        // All single-hop pools revert; 2-hop WETH/USDC bridge succeeds with 1,015 USDT output
        pool.setLiquidationBehavior(10000, 500 ether);
        router.setRoutingMode(true, true, 1_015_000_000);

        bot.triggerLiquidation(
            address(debtToken),
            address(collateralToken),
            borrower,
            1_000_000_000,
            500,
            5_000_000 // 5 USDT minProfit
        );

        assertEq(debtToken.balanceOf(coldProfitWallet), 14_500_000);
    }

    function test_Success_UnspentFlashLoanCountedTowardsFinalBalance() public {
        // Flashloan = 1,000 USDT, but Aave caps actual liquidation at 80% (800 USDT used, 200 USDT unspent in bot)
        // Swap of seized collateral yields 815 USDT -> finalBalance = 200 + 815 = 1,015 USDT
        // Total debt = 1000.5 USDT -> Net Profit = 14.5 USDT
        pool.setLiquidationBehavior(8000, 400 ether);
        router.setRoutingMode(false, false, 815_000_000);

        bot.triggerLiquidation(
            address(debtToken),
            address(collateralToken),
            borrower,
            1_000_000_000,
            500,
            10_000_000 // 10 USDT minProfit
        );

        assertEq(debtToken.balanceOf(coldProfitWallet), 14_500_000);
    }
}
