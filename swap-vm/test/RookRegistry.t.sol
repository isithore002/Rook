// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { RookRegistry } from "../src/registry/RookRegistry.sol";

contract RookRegistryTest is Test {
    RookRegistry internal registry;

    address internal underwriter1 = address(0x1111);
    address internal underwriter2 = address(0x2222);
    address internal buyer1 = address(0x3333);
    address internal buyer2 = address(0x4444);

    event CoverageSettled(
        bytes32 indexed txRef,
        address indexed underwriter,
        address indexed buyer,
        uint256 rate,
        uint256 size,
        uint256 timestamp
    );

    function setUp() public {
        registry = new RookRegistry();
    }

    function test_RecordCoverage_Success() public {
        bytes32 txRef = keccak256("tx-risky-01");
        uint256 rate = 1e18;
        uint256 size = 5000e18;

        vm.prank(buyer1);
        vm.expectEmit(true, true, true, true);
        emit CoverageSettled(txRef, underwriter1, buyer1, rate, size, block.timestamp);

        RookRegistry.CoverageRecord memory record = registry.recordCoverage(txRef, underwriter1, rate, size);

        assertEq(record.txRef, txRef);
        assertEq(record.underwriter, underwriter1);
        assertEq(record.buyer, buyer1);
        assertEq(record.rate, rate);
        assertEq(record.size, size);
        assertEq(record.timestamp, block.timestamp);
        assertEq(record.blockNumber, block.number);

        assertTrue(registry.hasCoverage(txRef));
        assertEq(registry.totalCoverages(), 1);

        RookRegistry.CoverageRecord memory fetched = registry.getCoverage(txRef);
        assertEq(fetched.txRef, txRef);
        assertEq(fetched.underwriter, underwriter1);
        assertEq(fetched.buyer, buyer1);
        assertEq(fetched.rate, rate);
        assertEq(fetched.size, size);

        RookRegistry.CoverageRecord memory atIndex = registry.getCoverageAtIndex(0);
        assertEq(atIndex.txRef, txRef);
    }

    function test_RecordCoverage_ExplicitBuyer() public {
        bytes32 txRef = keccak256("tx-explicit-buyer");
        uint256 rate = 2e18;
        uint256 size = 1000e18;

        vm.expectEmit(true, true, true, true);
        emit CoverageSettled(txRef, underwriter1, buyer2, rate, size, block.timestamp);

        RookRegistry.CoverageRecord memory record = registry.recordCoverage(txRef, underwriter1, buyer2, rate, size);

        assertEq(record.buyer, buyer2);
        assertEq(record.underwriter, underwriter1);
    }

    function test_RevertIf_DuplicateTxRef() public {
        bytes32 txRef = keccak256("tx-duplicate");
        registry.recordCoverage(txRef, underwriter1, buyer1, 1e18, 100e18);

        vm.expectRevert(abi.encodeWithSelector(RookRegistry.CoverageAlreadyRecorded.selector, txRef));
        registry.recordCoverage(txRef, underwriter2, buyer2, 2e18, 200e18);
    }

    function test_RevertIf_ZeroAddress() public {
        bytes32 txRef = keccak256("tx-zero-addr");

        vm.expectRevert(RookRegistry.ZeroAddress.selector);
        registry.recordCoverage(txRef, address(0), buyer1, 1e18, 100e18);

        vm.expectRevert(RookRegistry.ZeroAddress.selector);
        registry.recordCoverage(txRef, underwriter1, address(0), 1e18, 100e18);
    }

    function test_RevertIf_ZeroAmount() public {
        bytes32 txRef = keccak256("tx-zero-amount");

        vm.expectRevert(RookRegistry.ZeroAmount.selector);
        registry.recordCoverage(bytes32(0), underwriter1, buyer1, 1e18, 100e18);

        vm.expectRevert(RookRegistry.ZeroAmount.selector);
        registry.recordCoverage(txRef, underwriter1, buyer1, 0, 100e18);

        vm.expectRevert(RookRegistry.ZeroAmount.selector);
        registry.recordCoverage(txRef, underwriter1, buyer1, 1e18, 0);
    }

    function test_RevertIf_InvalidIndex() public {
        bytes32 unrecorded = keccak256("unrecorded");

        vm.expectRevert(RookRegistry.InvalidIndex.selector);
        registry.getCoverage(unrecorded);

        vm.expectRevert(RookRegistry.InvalidIndex.selector);
        registry.getCoverageAtIndex(0);
    }

    function test_PaginationAndFiltering() public {
        bytes32 ref1 = keccak256("ref1");
        bytes32 ref2 = keccak256("ref2");
        bytes32 ref3 = keccak256("ref3");

        registry.recordCoverage(ref1, underwriter1, buyer1, 1e18, 100e18);
        registry.recordCoverage(ref2, underwriter1, buyer2, 1e18, 200e18);
        registry.recordCoverage(ref3, underwriter2, buyer1, 2e18, 300e18);

        assertEq(registry.totalCoverages(), 3);

        // Test pagination
        RookRegistry.CoverageRecord[] memory page1 = registry.getCoverages(0, 2);
        assertEq(page1.length, 2);
        assertEq(page1[0].txRef, ref1);
        assertEq(page1[1].txRef, ref2);

        RookRegistry.CoverageRecord[] memory page2 = registry.getCoverages(2, 2);
        assertEq(page2.length, 1);
        assertEq(page2[0].txRef, ref3);

        RookRegistry.CoverageRecord[] memory emptyPage = registry.getCoverages(5, 10);
        assertEq(emptyPage.length, 0);

        // Test filter by underwriter
        RookRegistry.CoverageRecord[] memory u1Records = registry.getCoveragesByUnderwriter(underwriter1);
        assertEq(u1Records.length, 2);
        assertEq(u1Records[0].txRef, ref1);
        assertEq(u1Records[1].txRef, ref2);

        RookRegistry.CoverageRecord[] memory u2Records = registry.getCoveragesByUnderwriter(underwriter2);
        assertEq(u2Records.length, 1);
        assertEq(u2Records[0].txRef, ref3);

        // Test filter by buyer
        RookRegistry.CoverageRecord[] memory b1Records = registry.getCoveragesByBuyer(buyer1);
        assertEq(b1Records.length, 2);
        assertEq(b1Records[0].txRef, ref1);
        assertEq(b1Records[1].txRef, ref3);

        RookRegistry.CoverageRecord[] memory b2Records = registry.getCoveragesByBuyer(buyer2);
        assertEq(b2Records.length, 1);
        assertEq(b2Records[0].txRef, ref2);
    }

    function testFuzz_RecordCoverage(bytes32 txRef, address underwriter, address buyer, uint256 rate, uint256 size) public {
        vm.assume(txRef != bytes32(0));
        vm.assume(underwriter != address(0));
        vm.assume(buyer != address(0));
        vm.assume(rate > 0 && rate < type(uint128).max);
        vm.assume(size > 0 && size < type(uint128).max);

        RookRegistry.CoverageRecord memory record = registry.recordCoverage(txRef, underwriter, buyer, rate, size);

        assertEq(record.txRef, txRef);
        assertEq(record.underwriter, underwriter);
        assertEq(record.buyer, buyer);
        assertEq(record.rate, rate);
        assertEq(record.size, size);
    }
}
