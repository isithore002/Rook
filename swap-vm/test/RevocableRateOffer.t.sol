// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity ^0.8.27;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2026 Degensoft Ltd

import { AquaSwapVMTest } from "./base/AquaSwapVMTest.sol";
import { ISwapVM } from "../src/SwapVM.sol";
import { AquaSwapVMRouter } from "../src/routers/AquaSwapVMRouter.sol";
import { RevocableRateOffer } from "../src/instructions/RevocableRateOffer.sol";
import { dynamic } from "./utils/Dynamic.sol";

contract RevocableRateOfferTest is AquaSwapVMTest {
    bytes32 internal constant OFFER_ID = keccak256("offer-hedge-risk-01");
    uint128 internal constant MAX_SIZE = 1000e18;
    uint48 internal constant VALID_DURATION = 1 days;

    function setUp() public override {
        super.setUp();
    }

    function _buildOfferProgram(
        bool direction,
        bytes32 offerId,
        uint64 rateIn,
        uint64 rateOut,
        uint128 maxSize,
        uint48 validWhile
    ) internal pure returns (bytes memory) {
        return RevocableRateOffer.build(direction, offerId, rateIn, rateOut, maxSize, validWhile);
    }

    function test_RevocableRateOffer_ShipAndFill_ExactIn() public {
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        // zeroForOne = true means tokenA -> tokenB (direction = true since tokenA < tokenB)
        bytes memory program = _buildOfferProgram(true, OFFER_ID, 1, 1, MAX_SIZE, validWhile);
        ISwapVM.Order memory order = createStrategy(program);

        // Maker ships the strategy with 0 tokenA, 1000e18 tokenB (offering tokenB in exchange for tokenA)
        shipStrategy(order, tokenA, tokenB, 0, MAX_SIZE);

        SwapProgram memory swapProgram = SwapProgram({
            amount: 100e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: true
        });

        mintTokenInToTaker(swapProgram);
        mintTokenOutToMaker(swapProgram, MAX_SIZE);

        (uint256 amountIn, uint256 amountOut) = swap(swapProgram, order);

        assertEq(amountIn, 100e18, "Unexpected amountIn");
        assertEq(amountOut, 100e18, "Unexpected amountOut at 1:1 rate");

        (, uint128 filled,,) = AquaSwapVMRouter(payable(address(swapVM))).getOfferState(maker, OFFER_ID);
        assertEq(filled, 100e18, "Filled amount mismatch");
    }

    function test_RevocableRateOffer_ShipAndFill_ExactOut() public {
        bytes32 offerId = keccak256("offer-exact-out");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        bytes memory program = _buildOfferProgram(true, offerId, 1, 1, MAX_SIZE, validWhile);
        ISwapVM.Order memory order = createStrategy(program);

        shipStrategy(order, tokenA, tokenB, 0, MAX_SIZE);

        SwapProgram memory swapProgram = SwapProgram({
            amount: 50e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: false // exactOut
        });

        mintTokenInToTaker(swapProgram, 100e18);
        mintTokenOutToMaker(swapProgram, MAX_SIZE);

        (uint256 amountIn, uint256 amountOut) = swap(swapProgram, order);

        assertEq(amountOut, 50e18, "Unexpected amountOut");
        assertEq(amountIn, 50e18, "Unexpected amountIn at 1:1 rate");
    }

    function test_RevocableRateOffer_Reprice() public {
        bytes32 offerId = keccak256("offer-reprice");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        // Initial 1:1 rate
        bytes memory program = _buildOfferProgram(true, offerId, 1, 1, MAX_SIZE, validWhile);
        ISwapVM.Order memory order = createStrategy(program);

        shipStrategy(order, tokenA, tokenB, 0, MAX_SIZE);

        // Underwriter reprices the offer on-chain to 2 tokenA for 1 tokenB (rateIn: 2, rateOut: 1)
        vm.prank(maker);
        AquaSwapVMRouter(payable(address(swapVM))).repriceOffer(offerId, 2, 1);

        SwapProgram memory swapProgram = SwapProgram({
            amount: 100e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: true
        });

        mintTokenInToTaker(swapProgram);
        mintTokenOutToMaker(swapProgram, MAX_SIZE);

        (uint256 amountIn, uint256 amountOut) = swap(swapProgram, order);

        assertEq(amountIn, 100e18, "Unexpected amountIn");
        assertEq(amountOut, 50e18, "Expected 50 amountOut at 2:1 rate");
    }

    function test_RevocableRateOffer_Cancel_RevertsOnFill() public {
        bytes32 offerId = keccak256("offer-cancel");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        bytes memory program = _buildOfferProgram(true, offerId, 1, 1, MAX_SIZE, validWhile);
        ISwapVM.Order memory order = createStrategy(program);

        shipStrategy(order, tokenA, tokenB, 0, MAX_SIZE);

        // Underwriter cancels the offer on-chain
        vm.prank(maker);
        AquaSwapVMRouter(payable(address(swapVM))).cancelOffer(offerId);

        SwapProgram memory swapProgram = SwapProgram({
            amount: 100e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: true
        });

        mintTokenInToTaker(swapProgram);
        mintTokenOutToMaker(swapProgram, MAX_SIZE);

        vm.expectRevert();
        swap(swapProgram, order);
    }

    function test_RevocableRateOffer_AquaDock_RevertsOnFill() public {
        bytes32 offerId = keccak256("offer-dock");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        bytes memory program = _buildOfferProgram(true, offerId, 1, 1, MAX_SIZE, validWhile);
        ISwapVM.Order memory order = createStrategy(program);

        bytes32 strategyHash = shipStrategy(order, tokenA, tokenB, 0, MAX_SIZE);

        // Maker docks the strategy from Aqua
        vm.prank(maker);
        aqua.dock(address(swapVM), strategyHash, dynamic([address(tokenA), address(tokenB)]));

        SwapProgram memory swapProgram = SwapProgram({
            amount: 100e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: true
        });

        mintTokenInToTaker(swapProgram);
        mintTokenOutToMaker(swapProgram, MAX_SIZE);

        vm.expectRevert();
        swap(swapProgram, order);
    }

    function test_RevocableRateOffer_Expired_Reverts() public {
        bytes32 offerId = keccak256("offer-expired");
        uint48 validWhile = uint48(block.timestamp + 100);
        bytes memory program = _buildOfferProgram(true, offerId, 1, 1, MAX_SIZE, validWhile);
        ISwapVM.Order memory order = createStrategy(program);

        shipStrategy(order, tokenA, tokenB, 0, MAX_SIZE);

        SwapProgram memory swapProgram = SwapProgram({
            amount: 100e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: true
        });

        mintTokenInToTaker(swapProgram);
        mintTokenOutToMaker(swapProgram, MAX_SIZE);

        // Warp past validity duration
        vm.warp(validWhile + 1);

        vm.expectRevert();
        swap(swapProgram, order);
    }

    function test_RevocableRateOffer_CapacityExceeded_Reverts() public {
        bytes32 offerId = keccak256("offer-capacity");
        uint48 validWhile = uint48(block.timestamp + VALID_DURATION);
        uint128 smallCapacity = 100e18;
        bytes memory program = _buildOfferProgram(true, offerId, 1, 1, smallCapacity, validWhile);
        ISwapVM.Order memory order = createStrategy(program);

        shipStrategy(order, tokenA, tokenB, 0, smallCapacity);

        SwapProgram memory swapProgram = SwapProgram({
            amount: 100e18,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: true,
            isExactIn: true
        });

        mintTokenInToTaker(swapProgram);
        mintTokenOutToMaker(swapProgram, smallCapacity);

        // First fill exhausts the capacity
        (uint256 amountIn, uint256 amountOut) = swap(swapProgram, order);
        assertEq(amountIn, 100e18);
        assertEq(amountOut, 100e18);

        // Second fill attempt should fail because capacity is 0
        mintTokenInToTaker(swapProgram);
        vm.expectRevert();
        swap(swapProgram, order);
    }
}
