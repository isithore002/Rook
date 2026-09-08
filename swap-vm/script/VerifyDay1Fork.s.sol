// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2026 Degensoft Ltd

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { AquaSwapVMRouter } from "../src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "../src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "../src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "../src/libs/TakerTraits.sol";
import { RevocableRateOffer } from "../src/instructions/RevocableRateOffer.sol";

contract VerifyDay1Fork is Script {
    uint256 internal constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant MAKER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant TAKER_KEY = 0x5de4111afa1a4b94908f83103eb219e863dac2749d974a4904dd379c21ab018e;

    bytes32 internal constant OFFER_ID = keccak256("rook-hedge-offer-day1");
    uint128 internal constant MAX_CAPACITY = 10000e18;
    uint48 internal constant VALID_DURATION = 1 days;

    function run() external {
        address deployer = vm.addr(DEPLOYER_KEY);
        address maker = vm.addr(MAKER_KEY);
        address taker = vm.addr(TAKER_KEY);

        console2.log("=== DAY 1 OPCODES FORK VERIFICATION ===");
        console2.log("Deployer:", deployer);
        console2.log("Underwriter (Maker):", maker);
        console2.log("Acting Agent (Taker):", taker);

        // 1. DEPLOY INFRASTRUCTURE
        vm.startBroadcast(DEPLOYER_KEY);
        Aqua aqua = new Aqua();
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(0), deployer, "SwapVM", "1.0.0");
        
        TokenMock tokenA_temp = new TokenMock("Risky Token", "RISK");
        TokenMock tokenB_temp = new TokenMock("Safe Token", "SAFE");
        
        TokenMock tokenA;
        TokenMock tokenB;
        if (address(tokenA_temp) < address(tokenB_temp)) {
            tokenA = tokenA_temp;
            tokenB = tokenB_temp;
        } else {
            tokenA = tokenB_temp;
            tokenB = tokenA_temp;
        }

        // Fund Underwriter with SAFE token (tokenB) to offer protection
        tokenB.mint(maker, 100000e18);
        // Fund Acting Agent with RISK token (tokenA) that needs hedging
        tokenA.mint(taker, 100000e18);

        vm.stopBroadcast();

        console2.log("Aqua deployed at:", address(aqua));
        console2.log("AquaSwapVMRouter deployed at:", address(router));
        console2.log("Token A (sorted 0):", address(tokenA));
        console2.log("Token B (sorted 1):", address(tokenB));

        // 2. STEP 1: SHIP HEDGE OFFER
        console2.log("\n--- STEP 1: SHIP HEDGE OFFER (Rate 1:1, Max 10000 SAFE) ---");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        bytes memory opcodeProgram = RevocableRateOffer.build(true, OFFER_ID, 1, 1, MAX_CAPACITY, validWhile);
        
        ISwapVM.Order memory order = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker,
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            receiver: address(0),
            hasPreTransferInHook: false,
            hasPostTransferInHook: false,
            hasPreTransferOutHook: false,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: address(0),
            postTransferInData: "",
            preTransferOutTarget: address(0),
            preTransferOutData: "",
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: opcodeProgram
        }));

        bytes memory strategyBytes = abi.encode(order);

        vm.startBroadcast(MAKER_KEY);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);

        address[] memory shipTokens = new address[](2);
        shipTokens[0] = address(tokenA);
        shipTokens[1] = address(tokenB);

        uint256[] memory shipAmounts = new uint256[](2);
        shipAmounts[0] = 0;
        shipAmounts[1] = MAX_CAPACITY;

        bytes32 strategyHash = aqua.ship(address(router), strategyBytes, shipTokens, shipAmounts);
        vm.stopBroadcast();

        console2.log("[SUCCESS] Shipped strategyHash:", vm.toString(strategyHash));

        // 3. STEP 2: FILL HEDGE OFFER
        console2.log("\n--- STEP 2: FILL HEDGE OFFER (Swap 100 RISK for 100 SAFE) ---");
        bytes memory takerTraitsAndData = abi.encodePacked(TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: taker,
            isExactIn: true,
            shouldUnwrapWeth: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: false,
            useTransferFromAndAquaPush: false,
            isAToB: true,
            allowPartialFill: false,
            threshold: "",
            to: address(0),
            deadline: 0,
            hasPreTransferInCallback: false,
            hasPreTransferOutCallback: false,
            preTransferInHookData: "",
            postTransferInHookData: "",
            preTransferOutHookData: "",
            postTransferOutHookData: "",
            preTransferInCallbackData: "",
            preTransferOutCallbackData: "",
            instructionsArgs: "",
            signature: ""
        })));

        uint256 takerPreSafe = tokenB.balanceOf(taker);
        
        vm.startBroadcast(TAKER_KEY);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        (uint256 amountIn1, uint256 amountOut1, bytes32 orderHash1) = router.swap(order, 100e18, takerTraitsAndData);
        vm.stopBroadcast();

        uint256 takerPostSafe = tokenB.balanceOf(taker);
        require(amountIn1 == 100e18, "Fill 1 amountIn mismatch");
        require(amountOut1 == 100e18, "Fill 1 amountOut mismatch");
        require(takerPostSafe - takerPreSafe == 100e18, "Taker SafeToken balance mismatch");
        console2.log("[SUCCESS] Fill 1 completed! Swapped 100 RISK for 100 SAFE. OrderHash:", vm.toString(orderHash1));

        // Confirm on-chain state directly
        (, uint128 filled1,,) = router.getOfferState(maker, OFFER_ID);
        require(filled1 == 100e18, "On-chain state filledAmount mismatch");
        console2.log("[STATE CONFIRMED] On-chain state filledAmount: 100");

        // 4. STEP 3: REPRICE HEDGE OFFER
        console2.log("\n--- STEP 3: REPRICE HEDGE OFFER (New rate 2 RISK : 1 SAFE) ---");
        vm.startBroadcast(MAKER_KEY);
        router.repriceOffer(OFFER_ID, 2, 1);
        vm.stopBroadcast();

        (,, uint64 newRateIn, uint64 newRateOut) = router.getOfferState(maker, OFFER_ID);
        require(newRateIn == 2 && newRateOut == 1, "Repriced rate mismatch on-chain");
        console2.log("[STATE CONFIRMED] On-chain repriced rate: 2 : 1");

        // Fill at new rate: 100 RISK in -> should get 50 SAFE out
        takerPreSafe = tokenB.balanceOf(taker);
        vm.startBroadcast(TAKER_KEY);
        (uint256 amountIn2, uint256 amountOut2,) = router.swap(order, 100e18, takerTraitsAndData);
        vm.stopBroadcast();

        takerPostSafe = tokenB.balanceOf(taker);
        require(amountIn2 == 100e18, "Fill 2 amountIn mismatch");
        require(amountOut2 == 50e18, "Fill 2 amountOut mismatch (expected 50 at 2:1 rate)");
        require(takerPostSafe - takerPreSafe == 50e18, "Taker balance mismatch post-reprice");
        console2.log("[SUCCESS] Fill 2 completed at repriced rate! Swapped 100 RISK for 50 SAFE");

        // 5. STEP 4: CANCEL HEDGE OFFER
        console2.log("\n--- STEP 4: CANCEL HEDGE OFFER ---");
        vm.startBroadcast(MAKER_KEY);
        router.cancelOffer(OFFER_ID);
        vm.stopBroadcast();

        (bool isRevoked,,,) = router.getOfferState(maker, OFFER_ID);
        require(isRevoked, "isRevoked should be true on-chain");
        console2.log("[STATE CONFIRMED] On-chain isRevoked: true");

        console2.log("\n=== COMPLETE FLOW VERIFIED: SHIP -> FILL -> REPRICE -> CANCEL ===");
    }
}
