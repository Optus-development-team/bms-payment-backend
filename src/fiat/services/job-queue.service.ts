import { Injectable, ConflictException, Logger } from '@nestjs/common';

interface QrJobRecord {
  orderId: string;
  details: string;
  timestamp: number;
}

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private tail: Promise<void> = Promise.resolve();
  private readonly processedJobs = new Map<string, QrJobRecord>();
  private readonly JOB_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Check if a QR job with same orderId or details already exists
   */
  private isDuplicate(orderId: string, details: string): boolean {
    const now = Date.now();

    // Clean expired jobs
    for (const [key, record] of this.processedJobs.entries()) {
      if (now - record.timestamp > this.JOB_EXPIRY_MS) {
        this.processedJobs.delete(key);
      }
    }

    // Check for duplicate by orderId
    if (this.processedJobs.has(orderId)) {
      return true;
    }

    // Check for duplicate by details/glosa
    for (const record of this.processedJobs.values()) {
      if (record.details === details) {
        return true;
      }
    }

    return false;
  }

  /**
   * Register a QR job to prevent duplicates
   */
  private registerJob(orderId: string, details: string): void {
    this.processedJobs.set(orderId, {
      orderId,
      details,
      timestamp: Date.now(),
    });
  }

  /**
   * Attempt to register a QR job; returns false if duplicate.
   */
  tryRegisterQrJob(orderId: string, details: string): boolean {
    if (this.isDuplicate(orderId, details)) {
      return false;
    }
    this.registerJob(orderId, details);
    return true;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => task());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Enqueue a QR generation job with duplicate prevention
   */
  enqueueQrJob(
    orderId: string,
    details: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (!this.tryRegisterQrJob(orderId, details)) {
      this.logger.warn(
        `Duplicate QR job detected for orderId=${orderId} or details=${details}`,
      );
      throw new ConflictException(
        `Ya existe un QR en proceso o generado para la orden "${orderId}" o glosa "${details}"`,
      );
    }
    this.logger.log(`QR job registered: orderId=${orderId}, details=${details}`);

    return this.enqueue(task);
  }
}
