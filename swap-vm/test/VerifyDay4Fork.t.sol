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
import { AgentHedgeExecutor } from "../src/executor/AgentHedgeExecutor.sol";

contract MockRiskyTarget {
    uint256 public executeCount;

    function executeArbitrage(uint256 units) external returns (bool) {
        executeCount += units;
        return true;
    }

    function executeArbitrageAndYieldTokens(address token, address recipient, uint256 amount) external returns (bool) {
        TokenMock(token).transfer(recipient, amount);
        executeCount += 1;
        return true;
    }
}

contract VerifyDay4ForkTest is Test {
    address internal deployer = address(0x1111);

    // 3 Underwriter Personas
    address internal u1_conservative = address(0x2221); // AlphaConserv
    address internal u2_aggressive = address(0x2222);   // ApexHedge
    address internal u3_dynamic = address(0x2223);      // DeltaDynamic
    address internal unauthorized = address(0x9999);

    // Acting Agent & Compromised Target
    address internal actingAgent = address(0x3333);
    address internal exploitTarget = address(0x000000000000000000000000000000000000dEaD);

    bytes32 internal constant U1_OFFER_ID = keccak256("offer-u1-conservative");
    bytes32 internal constant U2_OFFER_ID = keccak256("offer-u2-aggressive");
    bytes32 internal constant U3_OFFER_ID = keccak256("offer-u3-dynamic");

    uint128 internal constant CAPACITY_U2 = 50000e18; // 50,000 SAFE capacity for full scenario
    uint256 internal constant VALID_DURATION = 1 days;

    Aqua internal aqua;
    AquaSwapVMRouter internal router;
    RookRegistry internal registry;
    AgentHedgeExecutor internal executor;
    MockRiskyTarget internal mockTarget;

    TokenMock internal tokenA; // RISK
    TokenMock internal tokenB; // SAFE

    function setUp() public {
        vm.startPrank(deployer);
        aqua = new Aqua();
        router = new AquaSwapVMRouter(address(aqua), address(0), deployer, "SwapVM", "1.0.0");
        registry = new RookRegistry();
        executor = new AgentHedgeExecutor(address(router), address(registry));
        mockTarget = new MockRiskyTarget();

        TokenMock tA = new TokenMock("Risky Token", "RISK");
        TokenMock tB = new TokenMock("Safe Token", "SAFE");
        if (address(tA) < address(tB)) {
            tokenA = tA;
            tokenB = tB;
        } else {
            tokenA = tB;
            tokenB = tA;
        }

        // Fund Underwriters with SAFE token
        tokenB.mint(u1_conservative, 100000e18);
        tokenB.mint(u2_aggressive, 100000e18);
        tokenB.mint(u3_dynamic, 100000e18);

        // Fund Acting Agent with RISK token
        tokenA.mint(actingAgent, 100000e18);
        tokenA.mint(address(mockTarget), 100000e18);

        // Configure blocked targets on Executor for tx-risky-02
        executor.setBlockedTarget(exploitTarget, true);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // INVARIANT 1 & 6 & 9: Successful Protected Execution (tx-risky-01)
    // -----------------------------------------------------------------
    function test_Day4_Invariant1_6_9_SuccessfulProtectedExecution() public {
        console2.log("\n--- TEST: Protected Execution with Atomic Target Call ---");
        bytes32 txRiskyRef = 0x2222222222222222222222222222222222222222222222222222222222222222;
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);

        // Underwriter 2 (ApexHedge) ships quote at 1.05 : 1
        ISwapVM.Order memory orderU2 = _shipQuote(u2_aggressive, U2_OFFER_ID, 105, 100, CAPACITY_U2, validWhile);

        bytes memory takerTraits = _buildTakerTraits(address(executor));
        bytes memory targetCalldata = abi.encodeWithSelector(MockRiskyTarget.executeArbitrage.selector, 42);

        uint256 riskIn = 5250e18;
        uint256 safeExpected = 5000e18;

        vm.startPrank(actingAgent);
        tokenA.approve(address(executor), riskIn);
        executor.executeProtected(
            txRiskyRef,
            address(tokenA),
            address(tokenB),
            orderU2,
            riskIn,
            takerTraits,
            105e16,
            address(mockTarget),
            targetCalldata
        );
        vm.stopPrank();

        // Invariant 9: Settlement produced verifiable on-chain state
        assertTrue(registry.hasCoverage(txRiskyRef), "Invariant 9: Coverage must be recorded in RookRegistry");
        assertEq(mockTarget.executeCount(), 42, "Target call must succeed when hedge succeeds");
        assertEq(tokenB.balanceOf(actingAgent), safeExpected, "Acting agent must hold acquired safe collateral");
        console2.log("[PASS] Invariant 1, 6, 9: Protected execution succeeded atomically.");
    }

    // -----------------------------------------------------------------
    // INVARIANT 2: Revocation / Repricing Authority Belongs Only to Maker
    // -----------------------------------------------------------------
    function test_Day4_Invariant2_MakerAuthorityOnly() public {
        console2.log("\n--- TEST: Invariant 2 (Maker Authority Only) ---");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        _shipQuote(u1_conservative, U1_OFFER_ID, 125, 100, 10000e18, validWhile);

        // Unauthorized user attempts to reprice u1's offer
        vm.startPrank(unauthorized);
        router.repriceOffer(U1_OFFER_ID, 101, 100);
        router.cancelOffer(U1_OFFER_ID);
        vm.stopPrank();

        // Verify u1's offer is NOT affected by unauthorized user
        (bool isRevokedU1,, uint64 rateInU1,) = router.getOfferState(u1_conservative, U1_OFFER_ID);
        assertFalse(isRevokedU1, "Invariant 2: Unauthorized user cannot revoke maker's offer");
        assertEq(rateInU1, 0, "Invariant 2: Unauthorized user cannot overwrite maker's override rate");

        // Verify unauthorized user only modified their own slot
        (bool isRevokedUnauth,, uint64 rateInUnauth,) = router.getOfferState(unauthorized, U1_OFFER_ID);
        assertTrue(isRevokedUnauth);
        assertEq(rateInUnauth, 101);
        console2.log("[PASS] Invariant 2: Maker authority strictly isolated by msg.sender.");
    }

    // -----------------------------------------------------------------
    // INVARIANT 3: filledAmount can never exceed maxSize
    // -----------------------------------------------------------------
    function test_Day4_Invariant3_CapacityEnforced() public {
        console2.log("\n--- TEST: Invariant 3 (Capacity Enforced) ---");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        // Ship capacity of exactly 1050 RISK (1000 SAFE out at 1.05:1)
        ISwapVM.Order memory order = _shipQuote(u2_aggressive, U2_OFFER_ID, 105, 100, 1050e18, validWhile);

        bytes memory takerTraits = _buildTakerTraits(actingAgent);

        // First fill: exactly 1050e18 (fills entire 1050e18 capacity)
        vm.startPrank(actingAgent);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        router.swap(order, 1050e18, takerTraits);

        // Verify filledAmount is now 1050e18
        (, uint128 filled,,) = router.getOfferState(u2_aggressive, U2_OFFER_ID);
        assertEq(filled, 1050e18, "Invariant 3: Filled amount must equal capacity");

        // Second fill attempt must revert with OfferCapacityExceeded
        vm.expectRevert();
        router.swap(order, 1050e18, takerTraits);
        vm.stopPrank();

        console2.log("[PASS] Invariant 3: Capacity strictly enforced; overfill reverts.");
    }

    // -----------------------------------------------------------------
    // INVARIANT 4: Expired / Revoked Offers Revert
    // -----------------------------------------------------------------
    function test_Day4_Invariant4_ExpiredOrRevokedOffersRevert() public {
        console2.log("\n--- TEST: Invariant 4 (Expired/Revoked Reverts) ---");
        uint48 validWhile = uint48(block.timestamp + 100);
        ISwapVM.Order memory order = _shipQuote(u3_dynamic, U3_OFFER_ID, 115, 100, 5000e18, validWhile);

        bytes memory takerTraits = _buildTakerTraits(actingAgent);

        // Test Revocation
        vm.prank(u3_dynamic);
        router.cancelOffer(U3_OFFER_ID);

        vm.startPrank(actingAgent);
        tokenA.approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swap(order, 1150e18, takerTraits);
        vm.stopPrank();

        // Re-ship with fresh offer and test Expiry
        bytes32 freshOfferId = keccak256("offer-fresh-expiry");
        ISwapVM.Order memory freshOrder = _shipQuote(u3_dynamic, freshOfferId, 115, 100, 5000e18, validWhile);

        vm.warp(block.timestamp + 200); // warp past validWhile
        vm.startPrank(actingAgent);
        vm.expectRevert();
        router.swap(freshOrder, 1150e18, takerTraits);
        vm.stopPrank();

        console2.log("[PASS] Invariant 4: Revoked and expired offers revert deterministically.");
    }

    // -----------------------------------------------------------------
    // INVARIANT 5: Insufficient Aqua Liquidity Reverts
    // -----------------------------------------------------------------
    function test_Day4_Invariant5_InsufficientAquaLiquidityReverts() public {
        console2.log("\n--- TEST: Invariant 5 (Insufficient Liquidity Reverts) ---");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        ISwapVM.Order memory order = _shipQuote(u2_aggressive, U2_OFFER_ID, 105, 100, 5000e18, validWhile);

        // Underwriter drains SAFE tokens out of wallet before fill
        vm.startPrank(u2_aggressive);
        tokenB.transfer(deployer, tokenB.balanceOf(u2_aggressive));
        vm.stopPrank();

        bytes memory takerTraits = _buildTakerTraits(actingAgent);

        vm.startPrank(actingAgent);
        tokenA.approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swap(order, 1050e18, takerTraits);
        vm.stopPrank();

        console2.log("[PASS] Invariant 5: Swap reverts when underwriter lacks wallet-resident liquidity.");
    }

    // -----------------------------------------------------------------
    // INVARIANT 6: CRITICAL SAFETY PROPERTY
    // "If the required hedge cannot be established, the risky transaction
    //  is NEVER allowed to execute."
    // -----------------------------------------------------------------
    function test_Day4_Invariant6_FailedHedgeCannotFallThrough() public {
        console2.log("\n--- TEST: Invariant 6 (Failed Hedge Prevents Risky Execution) ---");
        bytes32 txRiskyRef = 0x2222222222222222222222222222222222222222222222222222222222222222;
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);

        // Underwriter ships offer but immediately revokes it
        ISwapVM.Order memory order = _shipQuote(u2_aggressive, U2_OFFER_ID, 105, 100, CAPACITY_U2, validWhile);
        vm.prank(u2_aggressive);
        router.cancelOffer(U2_OFFER_ID);

        bytes memory takerTraits = _buildTakerTraits(address(executor));
        bytes memory targetCalldata = abi.encodeWithSelector(MockRiskyTarget.executeArbitrage.selector, 999);

        // Acting Agent attempts to execute via Executor
        vm.startPrank(actingAgent);
        tokenA.approve(address(executor), 5250e18);

        // Must revert because hedge swap fails!
        vm.expectRevert();
        executor.executeProtected(
            txRiskyRef,
            address(tokenA),
            address(tokenB),
            order,
            5250e18,
            takerTraits,
            105e16,
            address(mockTarget),
            targetCalldata
        );
        vm.stopPrank();

        // VERIFY: The risky target transaction was NEVER called!
        assertEq(mockTarget.executeCount(), 0, "CRITICAL: Target must NEVER execute if hedge fails!");
        assertFalse(registry.hasCoverage(txRiskyRef), "Registry must not record coverage");
        console2.log("[PASS] Invariant 6: Failed hedge safely blocked target call; zero funds lost.");
    }

    // -----------------------------------------------------------------
    // INVARIANT 10: tx-risky-02 (Flagged Exploit Address Fails Closed)
    // -----------------------------------------------------------------
    function test_Day4_Invariant10_TxRisky02_FailsClosed() public {
        console2.log("\n--- TEST: Invariant 10 (tx-risky-02 Flagged Address Fails Closed) ---");
        bytes32 txRisky02Ref = 0x3333333333333333333333333333333333333333333333333333333333333333;
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        ISwapVM.Order memory order = _shipQuote(u2_aggressive, U2_OFFER_ID, 105, 100, CAPACITY_U2, validWhile);

        bytes memory takerTraits = _buildTakerTraits(address(executor));
        bytes memory targetCalldata = hex"12345678";

        // Attempt to call executor with exploitTarget (configured as blocked target in setUp)
        vm.startPrank(actingAgent);
        tokenA.approve(address(executor), 5250e18);

        vm.expectRevert(abi.encodeWithSelector(AgentHedgeExecutor.TargetHardBlocked.selector, exploitTarget));
        executor.executeProtected(
            txRisky02Ref,
            address(tokenA),
            address(tokenB),
            order,
            5250e18,
            takerTraits,
            105e16,
            exploitTarget,
            targetCalldata
        );
        vm.stopPrank();

        console2.log("[PASS] Invariant 10: tx-risky-02 successfully hard-blocked on-chain.");
    }

    // -----------------------------------------------------------------
    // MODEL B: Atomic Conditional Exit Floor
    // Target executes first -> yields tokens to executor -> executor
    // atomically exercises pre-committed SwapVM floor -> safe output.
    // -----------------------------------------------------------------
    function test_Day4_ModelB_AtomicConditionalExitFloor() public {
        console2.log("\n--- TEST: Model B (Atomic Conditional Exit Floor) ---");
        bytes32 txRiskyRef = 0x5555555555555555555555555555555555555555555555555555555555555555;
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);

        // Pre-Execution Commitment: Underwriter 2 pre-commits 1.05:1 hedge quote
        ISwapVM.Order memory orderU2 = _shipQuote(u2_aggressive, U2_OFFER_ID, 105, 100, CAPACITY_U2, validWhile);

        bytes memory takerTraits = _buildTakerTraits(address(executor));
        uint256 riskYielded = 5250e18;
        uint256 safeExpected = 5000e18;

        // Target calldata: target produces 5250 RISK tokens directly to executor
        bytes memory targetCalldata = abi.encodeWithSelector(
            MockRiskyTarget.executeArbitrageAndYieldTokens.selector,
            address(tokenA),
            address(executor),
            riskYielded
        );

        uint256 agentPreSafe = tokenB.balanceOf(actingAgent);

        // Agent calls executeProtectedExit
        vm.startPrank(actingAgent);
        executor.executeProtectedExit(
            txRiskyRef,
            address(tokenA),
            address(tokenB),
            orderU2,
            riskYielded,
            takerTraits,
            105e16,
            address(mockTarget),
            targetCalldata
        );
        vm.stopPrank();

        // Verifications
        assertTrue(registry.hasCoverage(txRiskyRef), "Model B: Coverage must be recorded in RookRegistry");
        assertEq(mockTarget.executeCount(), 1, "Model B: Target call must execute successfully");
        assertEq(tokenB.balanceOf(actingAgent) - agentPreSafe, safeExpected, "Model B: Agent receives guaranteed safe floor");
        console2.log("[PASS] Model B: Target executed, floor atomically exercised, agent protected.");
    }

    function _shipQuote(
        address maker,
        bytes32 offerId,
        uint64 rateIn,
        uint64 rateOut,
        uint128 capacity,
        uint48 validWhile
    ) internal returns (ISwapVM.Order memory order) {
        bytes memory opcodeProgram = RevocableRateOffer.build(true, offerId, rateIn, rateOut, capacity, validWhile);

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
        shipAmounts[1] = capacity;

        aqua.ship(address(router), strategyBytes, shipTokens, shipAmounts);
        vm.stopPrank();
    }

    function _buildTakerTraits(address taker) internal pure returns (bytes memory) {
        return abi.encodePacked(TakerTraitsLib.build(TakerTraitsLib.Args({
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
    }
}
