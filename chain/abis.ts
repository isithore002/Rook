/** Minimal ABIs for the contracts the off-chain Rook agents touch. */

const ORDER_TUPLE = {
  type: "tuple",
  name: "order",
  components: [
    { name: "maker", type: "address" },
    { name: "traits", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;

export const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

export const aquaAbi = [
  {
    type: "function", name: "ship", stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategy", type: "bytes" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [{ name: "strategyHash", type: "bytes32" }],
  },
  {
    type: "function", name: "dock", stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "tokens", type: "address[]" },
    ],
    outputs: [],
  },
  {
    // Real Aqua event — no indexed fields; `strategy` is abi.encode(Order).
    type: "event", name: "Shipped",
    inputs: [
      { name: "maker", type: "address", indexed: false },
      { name: "app", type: "address", indexed: false },
      { name: "strategyHash", type: "bytes32", indexed: false },
      { name: "strategy", type: "bytes", indexed: false },
    ],
  },
] as const;

export const routerAbi = [
  {
    type: "function", name: "swap", stateMutability: "payable",
    inputs: [ORDER_TUPLE, { name: "amount", type: "uint256" }, { name: "takerTraitsAndData", type: "bytes" }],
    outputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOut", type: "uint256" }, { name: "orderHash", type: "bytes32" }],
  },
  { type: "function", name: "repriceOffer", stateMutability: "nonpayable", inputs: [{ name: "offerId", type: "bytes32" }, { name: "newRateIn", type: "uint64" }, { name: "newRateOut", type: "uint64" }], outputs: [] },
  { type: "function", name: "cancelOffer", stateMutability: "nonpayable", inputs: [{ name: "offerId", type: "bytes32" }], outputs: [] },
  {
    type: "event", name: "OfferRevoked",
    inputs: [
      { name: "maker", type: "address", indexed: true },
      { name: "offerId", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event", name: "OfferRepriced",
    inputs: [
      { name: "maker", type: "address", indexed: true },
      { name: "offerId", type: "bytes32", indexed: true },
      { name: "newRateIn", type: "uint64", indexed: false },
      { name: "newRateOut", type: "uint64", indexed: false },
    ],
  },
  {
    type: "function", name: "getOfferState", stateMutability: "view",
    inputs: [{ name: "maker", type: "address" }, { name: "offerId", type: "bytes32" }],
    outputs: [
      { name: "isRevoked", type: "bool" },
      { name: "filledAmount", type: "uint128" },
      { name: "overrideRateIn", type: "uint64" },
      { name: "overrideRateOut", type: "uint64" },
    ],
  },
] as const;

export const registryAbi = [
  { type: "function", name: "hasCoverage", stateMutability: "view", inputs: [{ name: "txRef", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "totalCoverages", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getCoverage", stateMutability: "view", inputs: [{ name: "txRef", type: "bytes32" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "txRef", type: "bytes32" },
        { name: "underwriter", type: "address" },
        { name: "buyer", type: "address" },
        { name: "rate", type: "uint256" },
        { name: "size", type: "uint256" },
        { name: "timestamp", type: "uint256" },
        { name: "blockNumber", type: "uint256" },
      ],
    }],
  },
  {
    type: "event", name: "CoverageSettled",
    inputs: [
      { name: "txRef", type: "bytes32", indexed: true },
      { name: "underwriter", type: "address", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "rate", type: "uint256", indexed: false },
      { name: "size", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

export const executorAbi = [
  {
    type: "function", name: "executeProtected", stateMutability: "nonpayable",
    inputs: [
      { name: "txRef", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      ORDER_TUPLE,
      { name: "swapAmountIn", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
      { name: "expectedHedgeRate", type: "uint256" },
      { name: "target", type: "address" },
      { name: "targetCalldata", type: "bytes" },
    ],
    outputs: [{ name: "targetResult", type: "bytes" }],
  },
  { type: "function", name: "setBlockedTarget", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "blocked", type: "bool" }], outputs: [] },
  { type: "function", name: "setBlockedTxRef", stateMutability: "nonpayable", inputs: [{ name: "txRef", type: "bytes32" }, { name: "blocked", type: "bool" }], outputs: [] },
  {
    type: "event", name: "ProtectedExecutionCompleted",
    inputs: [
      { name: "txRef", type: "bytes32", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "underwriter", type: "address", indexed: true },
      { name: "safeAmountOut", type: "uint256", indexed: false },
    ],
  },
] as const;

export const peripheryAbi = [
  {
    type: "function", name: "buildRevocableRateOfferOrder", stateMutability: "pure",
    inputs: [
      { name: "maker", type: "address" },
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "offerId", type: "bytes32" },
      { name: "rateIn", type: "uint64" },
      { name: "rateOut", type: "uint64" },
      { name: "maxSize", type: "uint128" },
      { name: "validWhile", type: "uint48" },
    ],
    outputs: [ORDER_TUPLE, { name: "strategyBytes", type: "bytes" }],
  },
  {
    type: "function", name: "buildTakerTraits", stateMutability: "pure",
    inputs: [{ name: "taker", type: "address" }, { name: "to", type: "address" }],
    outputs: [{ type: "bytes" }],
  },
] as const;
