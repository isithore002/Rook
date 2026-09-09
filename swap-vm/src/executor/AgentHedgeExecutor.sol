// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AquaSwapVMRouter } from "../routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "../interfaces/ISwapVM.sol";
import { RookRegistry } from "../registry/RookRegistry.sol";

/// @title AgentHedgeExecutor
/// @notice Atomic execution guard for autonomous agents.
/// @dev Guarantees Invariant 6: A risky transaction CANNOT execute unless
///      its pre-execution hedge is successfully filled on Aqua SwapVM and registered.
contract AgentHedgeExecutor {
    AquaSwapVMRouter public immutable router;
    RookRegistry public immutable registry;

    mapping(bytes32 => bool) public blockedTxRefs;
    mapping(address => bool) public blockedTargets;

    error TransactionHardBlocked(bytes32 txRef);
    error TargetHardBlocked(address target);
    error TargetExecutionFailed(bytes returnData);

    event ProtectedExecutionCompleted(
        bytes32 indexed txRef,
        address indexed target,
        address indexed underwriter,
        uint256 safeAmountOut
    );

    constructor(address _router, address _registry) {
        router = AquaSwapVMRouter(payable(_router));
        registry = RookRegistry(_registry);
    }

    function setBlockedTxRef(bytes32 txRef, bool blocked) external {
        blockedTxRefs[txRef] = blocked;
    }

    function setBlockedTarget(address target, bool blocked) external {
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

        // 1. Transfer risk tokens from caller to this contract and approve router
        IERC20(tokenIn).transferFrom(msg.sender, address(this), swapAmountIn);
        IERC20(tokenIn).approve(address(router), swapAmountIn);

        // 2. Execute atomic hedge swap via Aqua SwapVM (fails closed if underwriter fails)
        (, uint256 safeOut,) = router.swap(order, swapAmountIn, takerTraitsAndData);

        // 3. Record coverage proof in RookRegistry
        registry.recordCoverage(
            txRef,
            order.maker,
            expectedHedgeRate,
            safeOut
        );

        // 4. Transfer acquired safe collateral to caller
        IERC20(tokenOut).transfer(msg.sender, safeOut);

        // 5. Execute the target transaction (ONLY reachable if hedge succeeded!)
        if (target != address(0) && targetCalldata.length > 0) {
            (bool success, bytes memory ret) = target.call(targetCalldata);
            require(success, TargetExecutionFailed(ret));
            targetResult = ret;
        }

        emit ProtectedExecutionCompleted(txRef, target, order.maker, safeOut);
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

        // 1. Execute the risky target transaction (which acquires/mints tokenIn to this contract)
        if (target != address(0) && targetCalldata.length > 0) {
            (bool success, bytes memory ret) = target.call(targetCalldata);
            require(success, TargetExecutionFailed(ret));
            targetResult = ret;
        }

        // 2. Exercise the pre-committed underwriter hedge floor via SwapVM
        IERC20(tokenIn).approve(address(router), swapAmountIn);
        (, uint256 safeOut,) = router.swap(order, swapAmountIn, takerTraitsAndData);

        // 3. Record coverage proof in RookRegistry
        registry.recordCoverage(
            txRef,
            order.maker,
            expectedHedgeRate,
            safeOut
        );

        // 4. Transfer acquired safe collateral to caller
        IERC20(tokenOut).transfer(msg.sender, safeOut);

        emit ProtectedExecutionCompleted(txRef, target, order.maker, safeOut);
    }
}

