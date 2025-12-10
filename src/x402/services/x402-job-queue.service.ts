import { Injectable, Logger } from '@nestjs/common';

/**
 * X402 Job Queue Service
 *
 * Ensures sequential processing of x402 payment jobs.
 * Only one blockchain transaction can be processed at a time
 * to prevent nonce conflicts and ensure proper ordering.
 */
@Injectable()
export class X402JobQueueService {
  private readonly logger = new Logger(X402JobQueueService.name);

  /** Promise chain to ensure sequential processing */
  private tail: Promise<void> = Promise.resolve();

  /** Track current queue depth for monitoring */
  private queueDepth = 0;

  /**
   * Enqueue a task for sequential execution
   *
   * @param task - Async function to execute
   * @returns Promise resolving to task result
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.queueDepth++;
    this.logger.debug(`Job enqueued. Queue depth: ${this.queueDepth}`);

    const run = this.tail.then(async () => {
      try {
        return await task();
      } finally {
        this.queueDepth--;
        this.logger.debug(`Job completed. Queue depth: ${this.queueDepth}`);
      }
    });

    // Update tail to track when this job completes
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  /**
   * Get current queue depth
   */
  getQueueDepth(): number {
    return this.queueDepth;
  }

  /**
   * Check if queue is idle
   */
  isIdle(): boolean {
    return this.queueDepth === 0;
  }
}
