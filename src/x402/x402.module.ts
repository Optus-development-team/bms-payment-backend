import { Module } from '@nestjs/common';
import { X402Controller } from './x402.controller';
import {
  X402PaymentService,
  X402FacilitatorService,
  X402WebhookService,
  X402JobQueueService,
} from './services';

/**
 * X402 Payment Module
 *
 * Implements the x402 payment protocol for cryptocurrency payments
 * on Avalanche Fuji (testnet).
 *
 * Features:
 * - HTTP 402 Payment Required flow
 * - EIP-3009 transferWithAuthorization for gasless USDC transfers
 * - Manual confirmation workflow for agent verification
 * - Webhook notifications for payment events
 * - Sequential job queue for blockchain transactions
 */
@Module({
  controllers: [X402Controller],
  providers: [
    X402PaymentService,
    X402FacilitatorService,
    X402WebhookService,
    X402JobQueueService,
  ],
  exports: [X402PaymentService, X402FacilitatorService],
})
export class X402Module {}
