import { Injectable } from '@nestjs/common';

@Injectable()
export class JobQueueService {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => task());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
