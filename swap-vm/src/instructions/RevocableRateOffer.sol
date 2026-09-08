// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity ^0.8.27;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2026 Degensoft Ltd

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Context } from "../libs/VM.sol";
import { Opcode } from "../libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "../libs/MemoryPtr.sol";
import { StorageSlots } from "../libs/StorageSlots.sol";
import { InstructionBuilder } from "../libs/InstructionBuilder.sol";
import { InstructionArgs } from "../libs/InstructionArgs.sol";

/// @notice RevocableRateOffer opcode, enables underwriters to post revocable rate offers
///   with maximum hedge size, expiry timestamp, and on-chain repricing/cancellation capability.
/// @dev Encoding: [bool direction, bytes32 offerId, uint64 rateIn, uint64 rateOut, uint128 maxSize, uint48 validWhile]
library RevocableRateOffer {
    using InstructionArgs for bytes;
    using InstructionArgs for bytes32;

    using MemoryPtrLib for MemoryPtr;
    using InstructionBuilder for MemoryPtr;

    using Math for uint256;

    error DirectionMismatch();
    error OfferExpired(uint256 validWhile, uint256 currentTimestamp);
    error OfferRevokedError(address maker, bytes32 offerId);
    error OfferCapacityExceeded(uint256 maxSize, uint256 filledAmount);
    error InvalidRate();

    Opcode constant opcode = Opcode.RevocableRateOffer;

    function sizeOf() internal pure returns (uint256) {
        return InstructionBuilder.sizeOf() + 1 + 32 + 8 + 8 + 16 + 6;
    }

    function build(
        bool direction,
        bytes32 offerId,
        uint64 rateIn,
        uint64 rateOut,
        uint128 maxSize,
        uint48 validWhile
    ) internal pure returns (bytes memory) {
        return build(MemoryPtrLib.alloc(sizeOf()), direction, offerId, rateIn, rateOut, maxSize, validWhile).resolve();
    }

    function build(
        MemoryPtr ptrStart,
        bool direction,
        bytes32 offerId,
        uint64 rateIn,
        uint64 rateOut,
        uint128 maxSize,
        uint48 validWhile
    ) internal pure returns (MemoryPtr ptr) {
        ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(InstructionBuilder.encodeBool(direction, 0));
        ptr = ptr.push(offerId, 32);
        ptr = ptr.push(uint256(rateIn), 8);
        ptr = ptr.push(uint256(rateOut), 8);
        ptr = ptr.push(uint256(maxSize), 16);
        ptr = ptr.push(uint256(validWhile), 6);
        ptrStart.patchLength(ptr);
    }

    function parse(bytes calldata args)
        internal
        pure
        returns (
            bool direction,
            bytes32 offerId,
            uint64 rateIn,
            uint64 rateOut,
            uint128 maxSize,
            uint48 validWhile
        )
    {
        direction = args.at(0).asBool(0);
        offerId = args.at(1);
        rateIn = args.at(33).asU64();
        rateOut = args.at(41).asU64();
        maxSize = args.at(49).asU128();
        validWhile = args.at(65).asU48();
    }

    struct OfferState {
        bool isRevoked;
        uint128 filledAmount;
        uint64 overrideRateIn;
        uint64 overrideRateOut;
    }

    struct Storage {
        mapping(address maker => mapping(bytes32 offerId => OfferState)) offers;
    }

    function store() internal pure returns (Storage storage $) {
        bytes32 slot = StorageSlots.RevocableRateOffer;
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function exec(Context memory ctx, bytes calldata args) internal {
        (
            bool direction,
            bytes32 offerId,
            uint64 rateIn,
            uint64 rateOut,
            uint128 maxSize,
            uint48 validWhile
        ) = parse(args);

        bool swapDirection = ctx.query.tokenIn < ctx.query.tokenOut;
        require(direction == swapDirection, DirectionMismatch());
        require(block.timestamp <= validWhile, OfferExpired(validWhile, block.timestamp));

        Storage storage $ = store();
        OfferState storage state = $.offers[ctx.query.maker][offerId];
        require(!state.isRevoked, OfferRevokedError(ctx.query.maker, offerId));

        uint64 effRateIn = state.overrideRateIn > 0 ? state.overrideRateIn : rateIn;
        uint64 effRateOut = state.overrideRateOut > 0 ? state.overrideRateOut : rateOut;
        require(effRateIn > 0 && effRateOut > 0, InvalidRate());

        uint128 filled = state.filledAmount;
        require(maxSize > filled, OfferCapacityExceeded(maxSize, filled));
        uint256 remaining = maxSize - filled;

        if (ctx.query.isExactIn) {
            uint256 fillAmount = ctx.swap.amountIn;
            if (fillAmount > remaining) {
                fillAmount = remaining;
            }
            ctx.swap.amountIn = fillAmount;
            ctx.swap.amountOut = fillAmount * effRateOut / effRateIn;
        } else {
            uint256 maxOut = remaining * effRateOut / effRateIn;
            if (ctx.swap.amountOut > maxOut) {
                ctx.swap.amountOut = maxOut;
            }
            ctx.swap.amountIn = (ctx.swap.amountOut * effRateIn).ceilDiv(effRateOut);
        }

        if (!ctx.vm.isStaticContext) {
            state.filledAmount = filled + uint128(ctx.swap.amountIn);
        }
    }
}

contract RevocableRateOfferExternal {
    event OfferRevoked(address indexed maker, bytes32 indexed offerId);
    event OfferRepriced(address indexed maker, bytes32 indexed offerId, uint64 newRateIn, uint64 newRateOut);

    function cancelOffer(bytes32 offerId) external {
        RevocableRateOffer.Storage storage $ = RevocableRateOffer.store();
        $.offers[msg.sender][offerId].isRevoked = true;
        emit OfferRevoked(msg.sender, offerId);
    }

    function repriceOffer(bytes32 offerId, uint64 newRateIn, uint64 newRateOut) external {
        require(newRateIn > 0 && newRateOut > 0, RevocableRateOffer.InvalidRate());
        RevocableRateOffer.Storage storage $ = RevocableRateOffer.store();
        require(!$.offers[msg.sender][offerId].isRevoked, RevocableRateOffer.OfferRevokedError(msg.sender, offerId));
        $.offers[msg.sender][offerId].overrideRateIn = newRateIn;
        $.offers[msg.sender][offerId].overrideRateOut = newRateOut;
        emit OfferRepriced(msg.sender, offerId, newRateIn, newRateOut);
    }

    function getOfferState(address maker, bytes32 offerId)
        external
        view
        returns (
            bool isRevoked,
            uint128 filledAmount,
            uint64 overrideRateIn,
            uint64 overrideRateOut
        )
    {
        RevocableRateOffer.Storage storage $ = RevocableRateOffer.store();
        RevocableRateOffer.OfferState storage state = $.offers[maker][offerId];
        return (state.isRevoked, state.filledAmount, state.overrideRateIn, state.overrideRateOut);
    }
}
