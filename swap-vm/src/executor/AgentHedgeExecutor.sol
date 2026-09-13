// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AquaSwapVMRouter } from "../routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "../interfaces/ISwapVM.sol";
import { RookRegistry } from "../registry/RookRegistry.sol";

/// @title AgentHedgeExecutor
/// @notice Atomic execution guard for autonomous agents.
/// @dev Guarantees Invariant 6: A risky transaction CANNOT execute unless
///      its pre-execution hedge is successfully filled on Aqua SwapVM and registered.
contract AgentHedgeExecutor {
    using SafeERC20 for IERC20;

    AquaSwapVMRouter public immutable router;
    RookRegistry public immutable registry;
    /// @notice Only the owner may change the hard-block lists.
    address public immutable owner;

    mapping(bytes32 => bool) public blockedTxRefs;
    mapping(address => bool) public blockedTargets;

    error TransactionHardBlocked(bytes32 txRef);
    error TargetHardBlocked(address target);
    error TargetExecutionFailed(bytes returnData);
    error NotOwner(address caller);
    error TargetYieldShortfall(uint256 have, uint256 need);

    event ProtectedExecutionCompleted(
        bytes32 indexed txRef,
        address indexed target,
        address indexed underwriter,
        uint256 safeAmountOut
    );

    constructor(address _router, address _registry) {
        router = AquaSwapVMRouter(payable(_router));
        registry = RookRegistry(_registry);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    function setBlockedTxRef(bytes32 txRef, bool blocked) external onlyOwner {
        blockedTxRefs[txRef] = blocked;
    }

    function setBlockedTarget(address target, bool blocked) external onlyOwner {
        blockedTargets[target] = blocked;
    }

    /// @notice Atomically executes a pre-execution hedge swap, records settlement,
    ///         and ONLY THEN calls the risky target transaction.
    /// @dev If the hedge swap fails (offer expired, revoked, or insufficient liquidity),
    ///      the entire transaction reverts, ensuring the agent NEVER executes unhedged.
    function executeProtected(
        bytes32 txRef,
        address tokenIn,
        address tokenOut,
        ISwapVM.Order calldata order,
        uint256 swapAmountIn,
        bytes calldata takerTraitsAndData,
        uint256 expectedHedgeRate,
        address target,
        bytes calldata targetCalldata
    ) external returns (bytes memory targetResult) {
        require(!blockedTxRefs[txRef], TransactionHardBlocked(txRef));
        require(!blockedTargets[target], TargetHardBlocked(target));

        // 1. Pull the risk tokens from the caller, then hedge + record + forward the safe leg.
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), swapAmountIn);
        uint256 safeOut = _fillAndForward(
            txRef, tokenIn, tokenOut, order, swapAmountIn, takerTraitsAndData, expectedHedgeRate
        );

        // 2. Execute the target transaction (ONLY reachable if the hedge succeeded).
        if (target != address(0) && targetCalldata.length > 0) {
            (bool success, bytes memory ret) = target.call(targetCalldata);
            require(success, TargetExecutionFailed(ret));
            targetResult = ret;
        }
        emit ProtectedExecutionCompleted(txRef, target, order.maker, safeOut);
    }

    /// @dev Approve router, swap the risk leg for the safe leg, record coverage,
    ///      forward the safe tokens to the caller. Reverts (fails closed) if any step fails.
    function _fillAndForward(
        bytes32 txRef,
        address tokenIn,
        address tokenOut,
        ISwapVM.Order calldata order,
        uint256 swapAmountIn,
        bytes calldata takerTraitsAndData,
        uint256 expectedHedgeRate
    ) internal returns (uint256 safeOut) {
        IERC20(tokenIn).forceApprove(address(router), swapAmountIn);
        (, safeOut,) = router.swap(order, swapAmountIn, takerTraitsAndData);
        registry.recordCoverage(txRef, order.maker, expectedHedgeRate, safeOut);
        IERC20(tokenOut).safeTransfer(msg.sender, safeOut);
    }

    /// @notice Model B: Atomic Conditional Exit Floor
    /// @dev Target transaction executes first (producing tokenIn), and within the exact same
    ///      atomic transaction, the pre-committed underwriter SwapVM floor is exercised.
    ///      If the hedge fails or lacks liquidity, the entire transaction reverts, undoing the target call!
    function executeProtectedExit(
        bytes32 txRef,
        address tokenIn,
        address tokenOut,
        ISwapVM.Order calldata order,
        uint256 swapAmountIn,
        bytes calldata takerTraitsAndData,
        uint256 expectedHedgeRate,
        address target,
        bytes calldata targetCalldata
    ) external returns (bytes memory targetResult) {
        require(!blockedTxRefs[txRef], TransactionHardBlocked(txRef));
        require(!blockedTargets[target], TargetHardBlocked(target));

        // 1. Execute the risky target transaction (which acquires/mints tokenIn to this contract).
        if (target != address(0) && targetCalldata.length > 0) {
            (bool success, bytes memory ret) = target.call(targetCalldata);
            require(success, TargetExecutionFailed(ret));
            targetResult = ret;
        }

        // 1a. The target must actually have yielded the tokenIn we are about to hedge.
        require(
            IERC20(tokenIn).balanceOf(address(this)) >= swapAmountIn,
            TargetYieldShortfall(IERC20(tokenIn).balanceOf(address(this)), swapAmountIn)
        );

        // 2. Exercise the pre-committed underwriter hedge floor, record, forward.
        uint256 safeOut = _fillAndForward(
            txRef, tokenIn, tokenOut, order, swapAmountIn, takerTraitsAndData, expectedHedgeRate
        );
        emit ProtectedExecutionCompleted(txRef, target, order.maker, safeOut);
    }
}

