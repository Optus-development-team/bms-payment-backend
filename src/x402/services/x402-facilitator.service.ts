/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  type Address,
  type Hex,
  verifyTypedData,
} from 'viem';
import { avalancheFuji } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  X402_CONFIG,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  ExactEvmPayload,
  EIP712Domain,
  TransferWithAuthorizationTypes,
} from '../types';

/**
 * ERC-20 USDC ABI for transferWithAuthorization (EIP-3009)
 */
const USDC_ABI = [
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    name: 'transferWithAuthorization',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    name: 'authorizationState',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'version',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * X402 Facilitator Service
 *
 * Handles verification and settlement of x402 payments on Avalanche Fuji.
 * Implements the facilitator role in the x402 protocol:
 * - Verifies payment signatures and authorization
 * - Settles payments by executing transferWithAuthorization on-chain
 * - Provides gasless transactions for users (facilitator pays gas)
 */
@Injectable()
export class X402FacilitatorService implements OnModuleInit {
  private readonly logger = new Logger(X402FacilitatorService.name);
  private publicClient: any;
  private walletClient: any;
  private facilitatorAddress!: string;
  private isConfigured = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.initialize();
  }

  /**
   * Initialize the facilitator with blockchain clients
   */
  private initialize(): void {
    const privateKey = this.configService.get<string>(
      'X402_FACILITATOR_PRIVATE_KEY',
    );

    if (!privateKey) {
      this.logger.warn(
        'X402_FACILITATOR_PRIVATE_KEY not configured. X402 payment settlement will not be available.',
      );
      return;
    }

    try {
      // Ensure private key has 0x prefix
      const formattedKey = privateKey.startsWith('0x')
        ? (privateKey as Hex)
        : (`0x${privateKey}` as Hex);

      const account = privateKeyToAccount(formattedKey);
      this.facilitatorAddress = account.address;

      // Create public client for reading blockchain state
      this.publicClient = createPublicClient({
        chain: avalancheFuji,
        transport: http(X402_CONFIG.rpcUrl),
      });

      // Create wallet client for signing transactions
      this.walletClient = createWalletClient({
        account,
        chain: avalancheFuji,
        transport: http(X402_CONFIG.rpcUrl),
      });

      this.isConfigured = true;
      this.logger.log(
        `X402 Facilitator initialized on ${X402_CONFIG.network} with address ${this.facilitatorAddress}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to initialize X402 Facilitator: ${message}`);
    }
  }

  /**
   * Check if the facilitator is properly configured
   */
  isReady(): boolean {
    return this.isConfigured;
  }

  /**
   * Get the facilitator's wallet address
   */
  getFacilitatorAddress(): string | undefined {
    return this.facilitatorAddress;
  }

  /**
   * Get supported payment kinds
   */
  getSupported(): {
    kinds: Array<{
      x402Version: number;
      scheme: string;
      network: string;
    }>;
  } {
    return {
      kinds: [
        {
          x402Version: X402_CONFIG.x402Version,
          scheme: X402_CONFIG.scheme,
          network: X402_CONFIG.network,
        },
      ],
    };
  }

  /**
   * Verify a payment payload against payment requirements
   *
   * Verification steps:
   * 1. Check protocol version compatibility
   * 2. Validate scheme and network match
   * 3. Verify EIP-712 signature
   * 4. Check payer has sufficient USDC balance
   * 5. Verify payment amount meets requirements
   * 6. Check authorization timing validity
   * 7. Ensure nonce hasn't been used
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    if (!this.isConfigured) {
      return {
        isValid: false,
        invalidReason: 'Facilitator not configured',
      };
    }

    const payload = paymentPayload.payload as ExactEvmPayload;
    const { authorization, signature } = payload;

    try {
      // 1. Check protocol version
      if (paymentPayload.x402Version !== X402_CONFIG.x402Version) {
        return {
          isValid: false,
          invalidReason: 'invalid_version',
          payer: authorization.from,
        };
      }

      // 2. Validate scheme
      if (
        paymentPayload.scheme !== X402_CONFIG.scheme ||
        paymentRequirements.scheme !== X402_CONFIG.scheme
      ) {
        return {
          isValid: false,
          invalidReason: 'unsupported_scheme',
          payer: authorization.from,
        };
      }

      // 3. Validate network
      if (
        paymentPayload.network !== X402_CONFIG.network ||
        paymentRequirements.network !== X402_CONFIG.network
      ) {
        return {
          isValid: false,
          invalidReason: 'invalid_network',
          payer: authorization.from,
        };
      }

      // 4. Verify recipient matches
      if (
        authorization.to.toLowerCase() !==
        paymentRequirements.payTo.toLowerCase()
      ) {
        return {
          isValid: false,
          invalidReason: 'recipient_mismatch',
          payer: authorization.from,
        };
      }

      // 5. Verify amount is sufficient
      const payloadAmount = BigInt(authorization.value);
      const requiredAmount = BigInt(paymentRequirements.maxAmountRequired);
      if (payloadAmount < requiredAmount) {
        return {
          isValid: false,
          invalidReason: 'insufficient_amount',
          payer: authorization.from,
        };
      }

      // 6. Verify timing validity
      const now = Math.floor(Date.now() / 1000);
      const validAfter = parseInt(authorization.validAfter);
      const validBefore = parseInt(authorization.validBefore);

      if (now < validAfter) {
        return {
          isValid: false,
          invalidReason: 'authorization_not_yet_valid',
          payer: authorization.from,
        };
      }

      if (now >= validBefore) {
        return {
          isValid: false,
          invalidReason: 'authorization_expired',
          payer: authorization.from,
        };
      }

      // 7. Verify EIP-712 signature
      const domain: EIP712Domain = {
        name: X402_CONFIG.usdc.name,
        version: X402_CONFIG.usdc.version,
        chainId: X402_CONFIG.chainId,
        verifyingContract: X402_CONFIG.usdc.address,
      };

      const message = {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as Hex,
      };

      const isValidSignature = await verifyTypedData({
        address: authorization.from as Address,
        domain,
        types: TransferWithAuthorizationTypes,
        primaryType: 'TransferWithAuthorization',
        message,
        signature: signature as Hex,
      });

      if (!isValidSignature) {
        return {
          isValid: false,
          invalidReason: 'invalid_signature',
          payer: authorization.from,
        };
      }

      // 8. Check payer's USDC balance
      const balance = (await this.publicClient.readContract({
        address: X402_CONFIG.usdc.address,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [authorization.from as Address],
      })) as bigint;

      if (balance < payloadAmount) {
        return {
          isValid: false,
          invalidReason: 'insufficient_balance',
          payer: authorization.from,
        };
      }

      // 9. Check if nonce has already been used
      const nonceUsed = (await this.publicClient.readContract({
        address: X402_CONFIG.usdc.address,
        abi: USDC_ABI,
        functionName: 'authorizationState',
        args: [authorization.from as Address, authorization.nonce as Hex],
      })) as boolean;

      if (nonceUsed) {
        return {
          isValid: false,
          invalidReason: 'nonce_already_used',
          payer: authorization.from,
        };
      }

      this.logger.log(
        `Payment verified successfully for ${authorization.from} -> ${authorization.to}, amount: ${authorization.value}`,
      );

      return {
        isValid: true,
        payer: authorization.from,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Payment verification failed: ${message}`);
      return {
        isValid: false,
        invalidReason: `verification_error: ${message}`,
        payer: authorization.from,
      };
    }
  }

  /**
   * Settle a payment by executing transferWithAuthorization on-chain
   *
   * The facilitator submits the transaction and pays for gas.
   * The signed authorization from the user allows the USDC transfer.
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    if (!this.isConfigured) {
      return {
        success: false,
        errorReason: 'Facilitator not configured',
        transaction: '',
        network: X402_CONFIG.network,
      };
    }

    const payload = paymentPayload.payload as ExactEvmPayload;
    const { authorization, signature } = payload;

    try {
      // Re-verify payment before settlement
      const verifyResult = await this.verify(
        paymentPayload,
        paymentRequirements,
      );
      if (!verifyResult.isValid) {
        return {
          success: false,
          errorReason: verifyResult.invalidReason || 'verification_failed',
          transaction: '',
          network: X402_CONFIG.network,
          payer: authorization.from,
        };
      }

      // Parse the signature into v, r, s components
      const sig = parseSignature(signature as Hex);

      this.logger.log(
        `Settling payment: ${authorization.from} -> ${authorization.to}, amount: ${authorization.value}`,
      );

      // Execute transferWithAuthorization
      const txHash = await this.walletClient.writeContract({
        address: X402_CONFIG.usdc.address,
        abi: USDC_ABI,
        functionName: 'transferWithAuthorization',
        args: [
          authorization.from as Address,
          authorization.to as Address,
          BigInt(authorization.value),
          BigInt(authorization.validAfter),
          BigInt(authorization.validBefore),
          authorization.nonce as Hex,
          Number(sig.v),
          sig.r,
          sig.s,
        ],
      });

      this.logger.log(`Payment settled successfully. TX Hash: ${txHash}`);

      // Wait for transaction confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      if (receipt.status === 'reverted') {
        return {
          success: false,
          errorReason: 'transaction_reverted',
          transaction: txHash,
          network: X402_CONFIG.network,
          payer: authorization.from,
        };
      }

      return {
        success: true,
        transaction: txHash,
        network: X402_CONFIG.network,
        payer: authorization.from,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Payment settlement failed: ${message}`);
      return {
        success: false,
        errorReason: `settlement_error: ${message}`,
        transaction: '',
        network: X402_CONFIG.network,
        payer: authorization.from,
      };
    }
  }

  /**
   * Get USDC balance for an address
   */
  async getUsdcBalance(address: Address): Promise<bigint> {
    if (!this.isConfigured) {
      return 0n;
    }

    try {
      const balance = (await this.publicClient.readContract({
        address: X402_CONFIG.usdc.address,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint;
      return balance;
    } catch (error) {
      this.logger.error(`Failed to get USDC balance: ${error}`);
      return 0n;
    }
  }

  /**
   * Get block explorer URL for a transaction
   */
  getBlockExplorerUrl(txHash: string): string {
    return `${X402_CONFIG.blockExplorer}/tx/${txHash}`;
  }
}
