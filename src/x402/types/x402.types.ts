/**
 * X402 Protocol Types
 * Based on the x402 payment protocol specification (https://github.com/coinbase/x402)
 *
 * Network: Avalanche Fuji (testnet)
 * Chain ID: 43113
 * USDC Address: 0x5425890298aed601595a70AB815c96711a31Bc65
 */

// ============== Network Configuration ==============

export const X402_CONFIG = {
  // Avalanche Fuji Testnet Configuration
  network: 'avalanche-fuji',
  chainId: 43113,
  usdc: {
    address: '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`,
    name: 'USD Coin',
    decimals: 6,
    version: '2',
  },
  // x402 Protocol Version
  x402Version: 1,
  scheme: 'exact' as const,
  // Default timeout for payments (5 minutes)
  maxTimeoutSeconds: 300,
  // RPC URL for Avalanche Fuji
  rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
  // Block explorer
  blockExplorer: 'https://testnet.snowtrace.io',
} as const;

// ============== Payment Requirements ==============

/**
 * PaymentRequirements - Specifies what payment is required for a resource
 * Returned in HTTP 402 response body
 */
export interface PaymentRequirements {
  /** Scheme of the payment protocol (e.g., 'exact') */
  scheme: string;
  /** Network identifier (e.g., 'avalanche-fuji') */
  network: string;
  /** Maximum amount required in atomic units (wei for EVM) */
  maxAmountRequired: string;
  /** URL of the resource being paid for */
  resource: string;
  /** Human-readable description */
  description: string;
  /** MIME type of the response */
  mimeType: string;
  /** Address to receive the payment */
  payTo: string;
  /** Maximum time in seconds for the server to respond */
  maxTimeoutSeconds: number;
  /** ERC20 token contract address */
  asset: string;
  /** Additional schema information */
  outputSchema?: Record<string, unknown> | null;
  /** Extra EIP-712 information */
  extra?: {
    name: string;
    version: string;
  } | null;
}

// ============== Payment Payload ==============

/**
 * EIP-3009 Authorization parameters
 * Used for gasless USDC transfers via transferWithAuthorization
 */
export interface ExactEvmAuthorization {
  /** Address sending the payment */
  from: string;
  /** Address receiving the payment */
  to: string;
  /** Amount to transfer in atomic units */
  value: string;
  /** Unix timestamp after which the transfer is valid */
  validAfter: string;
  /** Unix timestamp before which the transfer is valid */
  validBefore: string;
  /** Unique nonce to prevent replay attacks */
  nonce: string;
}

/**
 * Exact scheme payload for EVM networks
 */
export interface ExactEvmPayload {
  /** EIP-3009 authorization parameters */
  authorization: ExactEvmAuthorization;
  /** EIP-712 typed data signature */
  signature: string;
}

/**
 * PaymentPayload - Sent in X-PAYMENT header (base64 encoded JSON)
 */
export interface PaymentPayload {
  /** x402 protocol version */
  x402Version: number;
  /** Payment scheme (e.g., 'exact') */
  scheme: string;
  /** Network identifier */
  network: string;
  /** Scheme-specific payload */
  payload: ExactEvmPayload;
}

// ============== Verification ==============

/**
 * Response from payment verification
 */
export interface VerifyResponse {
  /** Whether the payment is valid */
  isValid: boolean;
  /** Reason if payment is invalid */
  invalidReason?: string | null;
  /** Address of the payer */
  payer?: string;
}

// ============== Settlement ==============

/**
 * Response from payment settlement
 */
export interface SettleResponse {
  /** Whether the settlement succeeded */
  success: boolean;
  /** Error reason if failed */
  errorReason?: string | null;
  /** Transaction hash on blockchain */
  transaction: string;
  /** Network where settlement occurred */
  network: string;
  /** Address of the payer */
  payer?: string;
}

/**
 * Settlement response header (X-PAYMENT-RESPONSE)
 */
export interface SettlementResponseHeader {
  /** Whether settlement was successful */
  success: boolean;
  /** Transaction hash */
  txHash?: string;
  /** Network ID */
  networkId?: string;
  /** Chain ID */
  chainId?: number;
  /** Payer address */
  payer?: string;
}

// ============== HTTP 402 Response ==============

/**
 * Payment Required Response body for HTTP 402
 */
export interface PaymentRequiredResponse {
  /** x402 protocol version */
  x402Version: number;
  /** List of acceptable payment options */
  accepts: PaymentRequirements[];
  /** Error message if applicable */
  error?: string;
}

// ============== Job Types ==============

/**
 * X402 Payment Job status
 */
export type X402PaymentStatus =
  | 'pending'
  | 'payment_required'
  | 'payment_received'
  | 'verifying'
  | 'verified'
  | 'settling'
  | 'settled'
  | 'completed'
  | 'failed'
  | 'expired';

/**
 * X402 Payment Job
 */
export interface X402PaymentJob {
  /** Unique job identifier */
  jobId: string;
  /** Order ID from the business system */
  orderId: string;
  /** Amount in USD (human readable) */
  amountUsd: number;
  /** Amount in atomic units */
  amountAtomic: string;
  /** Resource being paid for */
  resource: string;
  /** Description */
  description: string;
  /** Current status */
  status: X402PaymentStatus;
  /** Payment requirements sent to client */
  paymentRequirements?: PaymentRequirements;
  /** Received payment payload */
  paymentPayload?: PaymentPayload;
  /** Verification result */
  verifyResponse?: VerifyResponse;
  /** Settlement result */
  settleResponse?: SettleResponse;
  /** Created timestamp */
  createdAt: Date;
  /** Updated timestamp */
  updatedAt: Date;
  /** Expiration timestamp */
  expiresAt: Date;
  /** Error message if failed */
  errorMessage?: string;
  /** Whether manual confirmation is required */
  requiresManualConfirmation: boolean;
  /** Manual confirmation status */
  manuallyConfirmed?: boolean;
  /** Manual confirmation timestamp */
  confirmedAt?: Date;
  /** Confirmer identifier */
  confirmedBy?: string;
}

// ============== Webhook Types ==============

/**
 * X402 Webhook event types
 */
export type X402WebhookEventType =
  | 'X402_PAYMENT_REQUIRED'
  | 'X402_PAYMENT_RECEIVED'
  | 'X402_PAYMENT_VERIFIED'
  | 'X402_PAYMENT_SETTLED'
  | 'X402_PAYMENT_CONFIRMED'
  | 'X402_PAYMENT_FAILED'
  | 'X402_PAYMENT_EXPIRED';

/**
 * X402 Webhook payload
 */
export interface X402WebhookPayload {
  type: X402WebhookEventType;
  orderId: string;
  jobId: string;
  data: {
    status: X402PaymentStatus;
    paymentRequirements?: PaymentRequirements;
    verifyResponse?: VerifyResponse;
    settleResponse?: SettleResponse;
    txHash?: string;
    blockExplorerUrl?: string;
    amountUsd?: number;
    payer?: string;
    error?: string;
    timestamp: string;
  };
}

// ============== Utility Types ==============

/**
 * EIP-712 Domain for USDC transferWithAuthorization
 */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

/**
 * EIP-712 Types for transferWithAuthorization
 */
export const TransferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * Convert USD amount to atomic units (6 decimals for USDC)
 */
export function usdToAtomic(usdAmount: number): string {
  const atomicAmount = BigInt(Math.floor(usdAmount * 1_000_000));
  return atomicAmount.toString();
}

/**
 * Convert atomic units to USD amount
 */
export function atomicToUsd(atomicAmount: string): number {
  return Number(BigInt(atomicAmount)) / 1_000_000;
}

/**
 * Generate a random nonce for EIP-3009
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Encode payment payload to base64 for X-PAYMENT header
 */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Decode X-PAYMENT header from base64
 */
export function decodePaymentHeader(encoded: string): PaymentPayload {
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
  return JSON.parse(decoded) as PaymentPayload;
}

/**
 * Encode settlement response for X-PAYMENT-RESPONSE header
 */
export function encodeSettlementHeader(
  response: SettlementResponseHeader,
): string {
  return Buffer.from(JSON.stringify(response)).toString('base64');
}
