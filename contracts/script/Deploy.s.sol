// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {Script, console2} from "forge-std/Script.sol";
import {LiquidationBot} from "../src/LiquidationBot.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        address aaveAddressProvider = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
        
        address swapRouter = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

        vm.startBroadcast(deployerPrivateKey);

        LiquidationBot bot = new LiquidationBot(aaveAddressProvider, swapRouter);

        vm.stopBroadcast();

        console2.log("=========================================");
        console2.log("LiquidationBot Deployment Successful");
        console2.log("BOT_CONTRACT_ADDRESS:", address(bot));
        console2.log("=========================================");
    }
}
