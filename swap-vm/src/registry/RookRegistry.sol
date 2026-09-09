// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RookRegistry
 * @notice Verifiable, judge-readable on-chain settlement registry for Rook hedges.
 * @dev Emits CoverageSettled events indexed by The Graph and provides query views.
 * Non-custodial: does not hold funds. The Aqua / SwapVM fill performs value transfer.
 */
contract RookRegistry {
    /// @notice Details of a settled coverage record
    struct CoverageRecord {
        bytes32 txRef;
        address underwriter;
        address buyer;
        uint256 rate;
        uint256 size;
        uint256 timestamp;
        uint256 blockNumber;
    }

    /// @notice Emitted when a hedge coverage is settled on-chain
    event CoverageSettled(
        bytes32 indexed txRef,
        address indexed underwriter,
        address indexed buyer,
        uint256 rate,
        uint256 size,
        uint256 timestamp
    );

    /// @notice Custom errors
    error CoverageAlreadyRecorded(bytes32 txRef);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidIndex();

    /// @dev Internal mapping from txRef to record
    mapping(bytes32 => CoverageRecord) private _coverages;
    /// @dev Sequential list of all txRefs
    bytes32[] private _allTxRefs;
    /// @dev Underwriter to list of txRefs
    mapping(address => bytes32[]) private _underwriterTxRefs;
    /// @dev Buyer to list of txRefs
    mapping(address => bytes32[]) private _buyerTxRefs;

    /**
     * @notice Record a settled coverage defaulting buyer to msg.sender
     * @param txRef Unique reference hash of the hedged transaction or risk event
     * @param underwriter Address of the underwriter providing coverage
     * @param rate Effective exchange rate of the hedge offer
     * @param size Size / amount of coverage settled
     */
    function recordCoverage(
        bytes32 txRef,
        address underwriter,
        uint256 rate,
        uint256 size
    ) external returns (CoverageRecord memory) {
        return recordCoverage(txRef, underwriter, msg.sender, rate, size);
    }

    /**
     * @notice Record a settled coverage with explicit buyer address
     * @param txRef Unique reference hash of the hedged transaction or risk event
     * @param underwriter Address of the underwriter providing coverage
     * @param buyer Address of the buyer / acting agent covered
     * @param rate Effective exchange rate of the hedge offer
     * @param size Size / amount of coverage settled
     */
    function recordCoverage(
        bytes32 txRef,
        address underwriter,
        address buyer,
        uint256 rate,
        uint256 size
    ) public returns (CoverageRecord memory) {
        if (txRef == bytes32(0)) revert ZeroAmount();
        if (underwriter == address(0) || buyer == address(0)) revert ZeroAddress();
        if (rate == 0 || size == 0) revert ZeroAmount();
        if (_coverages[txRef].timestamp != 0) revert CoverageAlreadyRecorded(txRef);

        CoverageRecord memory record = CoverageRecord({
            txRef: txRef,
            underwriter: underwriter,
            buyer: buyer,
            rate: rate,
            size: size,
            timestamp: block.timestamp,
            blockNumber: block.number
        });

        _coverages[txRef] = record;
        _allTxRefs.push(txRef);
        _underwriterTxRefs[underwriter].push(txRef);
        _buyerTxRefs[buyer].push(txRef);

        emit CoverageSettled(txRef, underwriter, buyer, rate, size, block.timestamp);

        return record;
    }

    /**
     * @notice Check whether a given txRef has been recorded
     */
    function hasCoverage(bytes32 txRef) external view returns (bool) {
        return _coverages[txRef].timestamp != 0;
    }

    /**
     * @notice Fetch coverage record by txRef
     */
    function getCoverage(bytes32 txRef) external view returns (CoverageRecord memory) {
        CoverageRecord memory record = _coverages[txRef];
        if (record.timestamp == 0) revert InvalidIndex();
        return record;
    }

    /**
     * @notice Total number of coverage settlements recorded
     */
    function totalCoverages() external view returns (uint256) {
        return _allTxRefs.length;
    }

    /**
     * @notice Fetch a coverage record by sequential index
     */
    function getCoverageAtIndex(uint256 index) external view returns (CoverageRecord memory) {
        if (index >= _allTxRefs.length) revert InvalidIndex();
        return _coverages[_allTxRefs[index]];
    }

    /**
     * @notice Paginated query of coverage records for UI and inspectors
     */
    function getCoverages(uint256 offset, uint256 limit) external view returns (CoverageRecord[] memory) {
        uint256 total = _allTxRefs.length;
        if (offset >= total || limit == 0) {
            return new CoverageRecord[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        uint256 resultSize = end - offset;

        CoverageRecord[] memory result = new CoverageRecord[](resultSize);
        for (uint256 i = 0; i < resultSize; i++) {
            result[i] = _coverages[_allTxRefs[offset + i]];
        }
        return result;
    }

    /**
     * @notice Fetch all coverage records for a specific underwriter
     */
    function getCoveragesByUnderwriter(address underwriter) external view returns (CoverageRecord[] memory) {
        bytes32[] memory refs = _underwriterTxRefs[underwriter];
        CoverageRecord[] memory result = new CoverageRecord[](refs.length);
        for (uint256 i = 0; i < refs.length; i++) {
            result[i] = _coverages[refs[i]];
        }
        return result;
    }

    /**
     * @notice Fetch all coverage records for a specific buyer
     */
    function getCoveragesByBuyer(address buyer) external view returns (CoverageRecord[] memory) {
        bytes32[] memory refs = _buyerTxRefs[buyer];
        CoverageRecord[] memory result = new CoverageRecord[](refs.length);
        for (uint256 i = 0; i < refs.length; i++) {
            result[i] = _coverages[refs[i]];
        }
        return result;
    }
}
