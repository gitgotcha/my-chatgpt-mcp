import type { DispatchRepository } from "./db.js";

/**
 * Bounded recovery coordinator.  It only dispatches rows already in the safe
 * dispatch_pending state; broker/sync leases require broker or operator proof
 * and are intentionally left untouched here.
 */
export class Reconciler {
  constructor(
    private readonly repository: Pick<DispatchRepository, "listDispatchPending">,
    private readonly dispatcher: { dispatch(jobId: string): Promise<void> },
    private readonly batchSize = 100
  ) {}

  async runFiveMinute(): Promise<void> {
    const jobs = await this.repository.listDispatchPending(Math.max(1, this.batchSize));
    await Promise.all(jobs.map((job) => this.dispatcher.dispatch(job.jobId)));
  }

  /** Expired active leases are observable, but never republished without verified reconciliation. */
  async runHourly(): Promise<void> { /* state fence deliberately has no automatic mutation */ }

  /** DLQ reconciliation is deliberately inert until a verified DLQ query adapter is configured. */
  async runSixHourly(): Promise<void> { /* no remote calls or unsafe replay */ }
}
