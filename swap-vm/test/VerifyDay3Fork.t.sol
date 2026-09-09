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

contract VerifyDay3ForkTest is Test {
    address internal deployer = address(0x1111);

    // 3 Underwriter Agents
    address internal u1_conservative = address(0x2221); // AlphaConserv
    address internal u2_aggressive = address(0x2222);   // ApexHedge
    address internal u3_dynamic = address(0x2223);      // DeltaDynamic

    // Acting Agent & Treasury
    address internal actingAgent = address(0x3333);
    address internal treasury = address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8);

    bytes32 internal constant U1_OFFER_ID = keccak256("offer-u1-conservative");
    bytes32 internal constant U2_OFFER_ID = keccak256("offer-u2-aggressive");
    bytes32 internal constant U3_OFFER_ID = keccak256("offer-u3-dynamic");

    uint128 internal constant MAX_CAPACITY = 50000e18;
    uint256 internal constant VALID_DURATION = 1 days;

    event CoverageSettled(
        bytes32 indexed txRef,
        address indexed underwriter,
        address indexed buyer,
        uint256 rate,
        uint256 size,
        uint256 timestamp
    );

    function test_Fork_Verify_Day3_Scenarios() public {
        console2.log("=== DAY 3 FORK VERIFICATION: TX-SAFE-01 & TX-RISKY-01 ===");

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

        // Fund Underwriters with SAFE token (tokenB)
        tokenB.mint(u1_conservative, 100000e18);
        tokenB.mint(u2_aggressive, 100000e18);
        tokenB.mint(u3_dynamic, 100000e18);

        // Fund Acting Agent with RISK token (tokenA)
        tokenA.mint(actingAgent, 100000e18);
        vm.stopPrank();

        console2.log("Aqua deployed at:", address(aqua));
        console2.log("AquaSwapVMRouter deployed at:", address(router));
        console2.log("RookRegistry deployed at:", address(registry));

        // -------------------------------------------------------------
        // SCENARIO 1: tx-safe-01 (Safe Transaction — No Hedge Required)
        // -------------------------------------------------------------
        console2.log("\n--- SCENARIO 1: tx-safe-01 (Routine Treasury Transfer) ---");
        bytes32 txSafeRef = 0x1111111111111111111111111111111111111111111111111111111111111111;
        uint256 safeAmount = 250e18;

        // Acting Agent executes direct transfer to treasury
        vm.startPrank(actingAgent);
        tokenA.transfer(treasury, safeAmount);
        vm.stopPrank();

        assertEq(tokenA.balanceOf(treasury), safeAmount, "Treasury should receive safe transfer");
        assertFalse(registry.hasCoverage(txSafeRef), "Safe tx must not have a coverage record");
        console2.log("[SUCCESS] tx-safe-01 executed directly without hedge. Registry coverage = false.");

        // -------------------------------------------------------------
        // SCENARIO 2: tx-risky-01 (Competitive Hedge & Settlement)
        // -------------------------------------------------------------
        console2.log("\n--- SCENARIO 2: tx-risky-01 (High-Value Arbitrage Transfer) ---");
        bytes32 txRiskyRef = 0x2222222222222222222222222222222222222222222222222222222222222222;
        uint256 hedgeAmount = 5000e18;
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);

        // 3 Underwriters ship competitive quotes on Aqua
        // Underwriter 1 (AlphaConserv): Rate 1.25 : 1 (125 / 100)
        _shipQuote(aqua, router, tokenA, tokenB, u1_conservative, U1_OFFER_ID, 125, 100, validWhile);
        console2.log("[QUOTE 1] AlphaConserv (u1) shipped rate: 1.25 : 1");

        // Underwriter 2 (ApexHedge): Rate 1.05 : 1 (105 / 100) -> BEST QUOTE!
        ISwapVM.Order memory orderU2 = _shipQuote(aqua, router, tokenA, tokenB, u2_aggressive, U2_OFFER_ID, 105, 100, validWhile);
        console2.log("[QUOTE 2] ApexHedge (u2) shipped rate: 1.05 : 1 (BEST QUOTE)");

        // Underwriter 3 (DeltaDynamic): Rate 1.15 : 1 (115 / 100)
        _shipQuote(aqua, router, tokenA, tokenB, u3_dynamic, U3_OFFER_ID, 115, 100, validWhile);
        console2.log("[QUOTE 3] DeltaDynamic (u3) shipped rate: 1.15 : 1");

        // Acting Agent selects BEST QUOTE: Underwriter 2 (ApexHedge at 1.05:1)
        console2.log("\n--- ACTING AGENT FILLS BEST QUOTE (ApexHedge) ---");
        bytes memory takerTraitsAndData = abi.encodePacked(TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: actingAgent,
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

        uint256 agentPreSafe = tokenB.balanceOf(actingAgent);

        // Swap 5250 RISK in -> receives 5000 SAFE out (1.05 : 1)
        uint256 riskIn = 5250e18;
        uint256 safeExpected = 5000e18;

        vm.startPrank(actingAgent);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        (uint256 amountIn, uint256 amountOut,) = router.swap(orderU2, riskIn, takerTraitsAndData);

        uint256 agentPostSafe = tokenB.balanceOf(actingAgent);
        assertEq(amountIn, riskIn, "Risk in mismatch");
        assertEq(amountOut, safeExpected, "Safe out mismatch at 1.05:1 rate");
        assertEq(agentPostSafe - agentPreSafe, safeExpected, "Safe balance received mismatch");
        console2.log("[SUCCESS] Filled ApexHedge quote: 5250 RISK swapped for 5000 SAFE (1.05:1 rate).");

        // Record settlement in RookRegistry
        console2.log("\n--- RECORD SETTLEMENT IN ROOK REGISTRY ---");
        vm.expectEmit(true, true, true, true);
        emit CoverageSettled(txRiskyRef, u2_aggressive, actingAgent, 105e16, hedgeAmount, block.timestamp);

        RookRegistry.CoverageRecord memory record = registry.recordCoverage(
            txRiskyRef,
            u2_aggressive,
            105e16, // 1.05e18 rate
            hedgeAmount
        );
        vm.stopPrank();

        // Verify Registry on-chain state
        assertTrue(registry.hasCoverage(txRiskyRef), "hasCoverage must be true for tx-risky-01");
        assertEq(record.underwriter, u2_aggressive, "Underwriter must be ApexHedge");
        assertEq(record.buyer, actingAgent, "Buyer must be Acting Agent");
        assertEq(record.size, hedgeAmount, "Size must match 5000e18");

        console2.log("[STATE CONFIRMED] tx-risky-01 coverage verified in RookRegistry!");
        console2.log("  txRef:", vm.toString(record.txRef));
        console2.log("  winning underwriter:", record.underwriter);
        console2.log("  rate: 1.05 : 1");
        console2.log("  settled capacity:", record.size);

        // -------------------------------------------------------------
        // LIVE MARKET DYNAMICS: Reprice & Cancel Demonstration
        // -------------------------------------------------------------
        console2.log("\n--- LIVE MARKET DYNAMICS: REPRICE & CANCEL ---");
        // Underwriter 1 reprices to become more competitive (new rate 1.08:1)
        vm.startPrank(u1_conservative);
        router.repriceOffer(U1_OFFER_ID, 108, 100);
        (,, uint64 newRateIn, uint64 newRateOut) = router.getOfferState(u1_conservative, U1_OFFER_ID);
        assertEq(newRateIn, 108);
        assertEq(newRateOut, 100);
        vm.stopPrank();
        console2.log("[SUCCESS] AlphaConserv repriced offer to 1.08 : 1 on-chain.");

        // Underwriter 3 cancels offer
        vm.startPrank(u3_dynamic);
        router.cancelOffer(U3_OFFER_ID);
        (bool isRevoked,,,) = router.getOfferState(u3_dynamic, U3_OFFER_ID);
        assertTrue(isRevoked, "DeltaDynamic offer must be revoked");
        vm.stopPrank();
        console2.log("[SUCCESS] DeltaDynamic cancelled offer on-chain (isRevoked = true).");

        console2.log("\n=== DAY 3 FORK-VERIFIED: COMPLETE DEMO SPINE VALIDATED ===");
    }

    function _shipQuote(
        Aqua aqua,
        AquaSwapVMRouter router,
        TokenMock tokenA,
        TokenMock tokenB,
        address maker,
        bytes32 offerId,
        uint64 rateIn,
        uint64 rateOut,
        uint48 validWhile
    ) internal returns (ISwapVM.Order memory order) {
        bytes memory opcodeProgram = RevocableRateOffer.build(true, offerId, rateIn, rateOut, MAX_CAPACITY, validWhile);

        order = MakerTraitsLib.build(MakerTraitsLib.Args({
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

        aqua.ship(address(router), strategyBytes, shipTokens, shipAmounts);
        vm.stopPrank();
    }
}
