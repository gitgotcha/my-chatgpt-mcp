export class Reconciler {
  constructor(repository, dispatcher, batchSize = 100, clock = () => new Date()) {
    this.repository = repository;
    this.dispatcher = dispatcher;
    this.batchSize = batchSize;
    this.clock = clock;
  }

  async runFiveMinute() {
    await this.repository.requeueExpiredLeases?.(this.clock());
    const jobs = await this.repository.listDispatchPending(Math.max(1, this.batchSize));
    await Promise.all(jobs.map((job) => this.dispatcher.dispatch(job.jobId)));
  }

  async runHourly() {
    return this.runFiveMinute();
  }

  async runSixHourly() {
    return this.runFiveMinute();
  }
}
