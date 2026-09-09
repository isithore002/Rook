// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { console2 } from "forge-std/console2.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { AquaSwapVMRouter } from "../src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "../src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "../src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "../src/libs/TakerTraits.sol";
import { RevocableRateOffer } from "../src/instructions/RevocableRateOffer.sol";
import { RookRegistry } from "../src/registry/RookRegistry.sol";

contract VerifyDay2ForkTest is Test {
    address internal deployer = address(0x1111);
    address internal maker = address(0x2222);
    address internal taker = address(0x3333);

    bytes32 internal constant OFFER_ID = keccak256("rook-hedge-offer-day2");
    uint128 internal constant MAX_CAPACITY = 20000e18;
    uint256 internal constant VALID_DURATION = 1 days;

    event CoverageSettled(
        bytes32 indexed txRef,
        address indexed underwriter,
        address indexed buyer,
        uint256 rate,
        uint256 size,
        uint256 timestamp
    );

    function test_Fork_Verify_Day2_Fill_And_RecordCoverage() public {
        console2.log("=== DAY 2 FORK VERIFICATION: SHIP -> FILL -> RECORD COVERAGE ===");
        console2.log("Deployer:", deployer);
        console2.log("Underwriter (Maker):", maker);
        console2.log("Acting Agent (Taker):", taker);

        // 1. DEPLOY INFRASTRUCTURE
        vm.startPrank(deployer);
        Aqua aqua = new Aqua();
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(0), deployer, "SwapVM", "1.0.0");
        RookRegistry registry = new RookRegistry();

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
        vm.stopPrank();

        console2.log("Aqua deployed at:", address(aqua));
        console2.log("AquaSwapVMRouter deployed at:", address(router));
        console2.log("RookRegistry deployed at:", address(registry));

        // 2. STEP 1: SHIP HEDGE OFFER (Rate 1:1, Max 20000 SAFE)
        console2.log("\n--- STEP 1: SHIP HEDGE OFFER (Rate 1:1, Max 20000 SAFE) ---");
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

        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);

        address[] memory shipTokens = new address[](2);
        shipTokens[0] = address(tokenA);
        shipTokens[1] = address(tokenB);

        uint256[] memory shipAmounts = new uint256[](2);
        shipAmounts[0] = 0;
        shipAmounts[1] = MAX_CAPACITY;

        bytes32 strategyHash = aqua.ship(address(router), strategyBytes, shipTokens, shipAmounts);
        vm.stopPrank();

        console2.log("[SUCCESS] Shipped strategyHash:", vm.toString(strategyHash));

        // 3. STEP 2: FILL HEDGE OFFER
        console2.log("\n--- STEP 2: FILL HEDGE OFFER (Swap 500 RISK for 500 SAFE) ---");
        bytes memory takerTraitsAndData = abi.encodePacked(TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: taker,
            isExactIn: true,
            shouldUnwrapWeth: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: false,
            useTransferFromAndAquaPush: true,
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

        vm.startPrank(taker);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) = router.swap(order, 500e18, takerTraitsAndData);
        vm.stopPrank();

        uint256 takerPostSafe = tokenB.balanceOf(taker);
        assertEq(amountIn, 500e18, "Fill amountIn mismatch");
        assertEq(amountOut, 500e18, "Fill amountOut mismatch");
        assertEq(takerPostSafe - takerPreSafe, 500e18, "Taker SafeToken balance mismatch");
        assertEq(orderHash, strategyHash, "OrderHash mismatch");
        console2.log("[SUCCESS] Fill completed! Swapped 500 RISK for 500 SAFE.");

        // 4. STEP 3: RECORD COVERAGE IN ROOK REGISTRY
        console2.log("\n--- STEP 3: RECORD COVERAGE IN ROOK REGISTRY ---");
        bytes32 txRef = keccak256("tx-risky-01-cross-chain-arbitrage");

        vm.startPrank(taker);
        vm.expectEmit(true, true, true, true);
        emit CoverageSettled(txRef, maker, taker, 1e18, 500e18, block.timestamp);

        RookRegistry.CoverageRecord memory record = registry.recordCoverage(
            txRef,
            maker,
            1e18,
            500e18
        );
        vm.stopPrank();

        // 5. STEP 4: VERIFY ON-CHAIN REGISTRY STATE
        console2.log("\n--- STEP 4: VERIFY ON-CHAIN REGISTRY STATE ---");
        assertEq(record.txRef, txRef, "txRef mismatch");
        assertEq(record.underwriter, maker, "underwriter mismatch");
        assertEq(record.buyer, taker, "buyer mismatch");
        assertEq(record.rate, 1e18, "rate mismatch");
        assertEq(record.size, 500e18, "size mismatch");
        assertEq(record.timestamp, block.timestamp, "timestamp mismatch");

        assertTrue(registry.hasCoverage(txRef), "hasCoverage must be true");
        assertEq(registry.totalCoverages(), 1, "totalCoverages mismatch");

        RookRegistry.CoverageRecord memory query = registry.getCoverage(txRef);
        assertEq(query.txRef, txRef);
        assertEq(query.underwriter, maker);
        assertEq(query.buyer, taker);
        assertEq(query.size, 500e18);

        RookRegistry.CoverageRecord[] memory uwRecords = registry.getCoveragesByUnderwriter(maker);
        assertEq(uwRecords.length, 1);
        assertEq(uwRecords[0].txRef, txRef);

        RookRegistry.CoverageRecord[] memory buyerRecords = registry.getCoveragesByBuyer(taker);
        assertEq(buyerRecords.length, 1);
        assertEq(buyerRecords[0].txRef, txRef);

        console2.log("[STATE CONFIRMED] On-chain coverage record verified successfully!");
        console2.log("  txRef:", vm.toString(record.txRef));
        console2.log("  underwriter:", record.underwriter);
        console2.log("  buyer:", record.buyer);
        console2.log("  size (hedged):", record.size);
        console2.log("  rate:", record.rate);
        console2.log("  blockNumber:", record.blockNumber);

        console2.log("\n=== DAY 2 FORK-VERIFIED: SHIP -> FILL -> RECORD COVERAGE COMPLETE ===");
    }
}
