// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { ISwapVM } from "../interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "../libs/MakerTraits.sol";
import { TakerTraitsLib } from "../libs/TakerTraits.sol";
import { RevocableRateOffer } from "../instructions/RevocableRateOffer.sol";

/// @title RookPeriphery
/// @notice `view`/`pure` helpers so Rook's off-chain agents construct SwapVM
///         orders and taker traits through the *canonical* Solidity encoders
///         (`MakerTraitsLib` / `TakerTraitsLib` / `RevocableRateOffer`), rather
///         than re-implementing the bit-packed encoding in TypeScript and
///         maintaining a second source of truth (CLAUDE.md §2). Holds no state
///         and moves no funds.
contract RookPeriphery {
    /// @notice Build a maker Order carrying the RevocableRateOffer opcode.
    /// @return order         The Order to pass to `router.swap` / `AgentHedgeExecutor`.
    /// @return strategyBytes `abi.encode(order)` — the `strategy` arg for `aqua.ship`.
    function buildRevocableRateOfferOrder(
        address maker,
        address tokenA,
        address tokenB,
        bytes32 offerId,
        uint64 rateIn,
        uint64 rateOut,
        uint128 maxSize,
        uint48 validWhile
    ) external pure returns (ISwapVM.Order memory order, bytes memory strategyBytes) {
        bytes memory program = RevocableRateOffer.build(tokenA < tokenB, offerId, rateIn, rateOut, maxSize, validWhile);

        order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: tokenA,
                tokenB: tokenB,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
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
                program: program
            })
        );

        strategyBytes = abi.encode(order);
    }

    /// @notice Build the packed `takerTraitsAndData` blob for a RISK->SAFE exact-in fill.
    function buildTakerTraits(address taker, address to) external pure returns (bytes memory) {
        return abi.encodePacked(
            TakerTraitsLib.build(
                TakerTraitsLib.Args({
                    taker: taker,
                    isExactIn: true,
                    shouldUnwrapWeth: false,
                    isStrictThresholdAmount: false,
                    isFirstTransferFromTaker: false,
                    useTransferFromAndAquaPush: true,
                    isAToB: true,
                    allowPartialFill: false,
                    threshold: "",
                    to: to,
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
                })
            )
        );
    }
}

/// @notice Minimal mintable ERC20 for the local Rook demo stack (fork/test funds only).
contract RookMintableToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Stand-in "risky target" for the local demo — an unverified counterparty
///         the acting agent interacts with once its hedge is in place.
contract RookDemoTarget {
    uint256 public executeCount;

    function executeArbitrage(uint256 units) external returns (bool) {
        executeCount += units;
        return true;
    }
}
