import * as log from '../util/log.js';

export interface JobContext {
  cwd: string;
}

export interface JobDefinition {
  id: string;
  intervalMs: number;
  runOnStart?: boolean;
  run: (ctx: JobContext) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class JobScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly running = new Map<string, boolean>();
  private stopped = false;

  constructor(
    private readonly jobs: ReadonlyArray<JobDefinition>,
    private readonly ctx: JobContext,
  ) {}

  async start(): Promise<void> {
    for (const job of this.jobs) {
      if (job.runOnStart !== false) {
        await this.runOne(job);
      }
      if (this.stopped) {
        return;
      }
      const timer = setInterval(() => {
        void this.runOne(job);
      }, job.intervalMs);
      this.timers.set(job.id, timer);
    }
  }

  async runOnce(): Promise<void> {
    for (const job of this.jobs) {
      await this.runOne(job);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private async runOne(job: JobDefinition): Promise<void> {
    if (this.running.get(job.id) === true) {
      return;
    }
    this.running.set(job.id, true);
    try {
      await job.run(this.ctx);
    } catch (err) {
      log.warn(`[daemon ${job.id}] tick failed: ${errorMessage(err)}`);
    } finally {
      this.running.set(job.id, false);
    }
  }
}
