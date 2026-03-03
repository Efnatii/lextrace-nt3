export class JobQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.stopped = false;
    this.idCounter = 0;
  }

  push(run) {
    if (this.stopped) {
      return Promise.reject(new Error("Queue stopped"));
    }
    const jobId = `job_${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      this.queue.push({ jobId, run, resolve, reject });
      this.flush();
    });
  }

  flush() {
    if (this.stopped) {
      return;
    }
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(() => item.run())
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.active -= 1;
          this.flush();
        });
    }
  }

  setConcurrency(nextConcurrency) {
    this.concurrency = Math.max(1, nextConcurrency);
    this.flush();
  }

  clearPending(error = new Error("Queue cleared")) {
    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) {
      item.reject(error);
    }
  }

  stop(error = new Error("Queue stopped")) {
    this.stopped = true;
    this.clearPending(error);
  }

  size() {
    return this.queue.length;
  }
}