import { Worker } from 'node:worker_threads'

// Fixed, local worker source keeps native Node workers independent of the Vite
// output layout. Paths are message data, never interpolated into executable code.
const source = String.raw`
const {parentPort} = require('node:worker_threads');
const {createReadStream} = require('node:fs');
const {createHash} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
parentPort.on('message', async path => {
  try {
    const hash = createHash('md5');
    await pipeline(createReadStream(path, {highWaterMark: 1024 * 1024}), hash);
    parentPort.postMessage({digest: hash.digest('hex')});
  } catch (error) {
    parentPort.postMessage({error: {message: error.message, code: error.code}});
  }
});`

interface Job { path: string; resolve: (hash: string) => void; reject: (error: Error) => void }
interface Slot { worker: Worker; job?: Job }

/** Lazy, bounded hashing off the Electron main thread. No workers on warm Play. */
export class VerificationWorkers {
  private slots: Slot[] = []
  private queue: Job[] = []
  private failure?: Error
  private closed = false
  constructor(private readonly count: number) {}

  hash(path: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new Error('Verification workers are closed.'))
    return new Promise((resolve, reject) => {
      this.queue.push({ path, resolve, reject })
      this.dispatch()
    })
  }

  private fail(error: Error): void {
    this.failure = error
    for (const slot of this.slots) { slot.job?.reject(error); slot.job = undefined }
    for (const job of this.queue.splice(0)) job.reject(error)
  }

  private dispatch(): void {
    if (this.closed || this.failure) return
    while (this.queue.length) {
      let slot = this.slots.find(candidate => !candidate.job)
      if (!slot) {
        if (this.slots.length >= this.count) return
        try {
          slot = { worker: new Worker(source, { eval: true }) }
        } catch (error) { this.fail(error as Error); return }
        const created = slot
        created.worker.on('message', (result: { digest?: string; error?: { message: string; code?: string } }) => {
          const job = created.job
          created.job = undefined
          if (!job) return
          if (result.error) job.reject(Object.assign(new Error(result.error.message), { code: result.error.code }))
          else if (typeof result.digest === 'string' && /^[a-f0-9]{32}$/.test(result.digest)) job.resolve(result.digest)
          else { job.reject(new Error('Invalid verification worker result.')); this.fail(new Error('Invalid verification worker result.')); return }
          this.dispatch()
        })
        created.worker.on('error', error => this.fail(error))
        created.worker.on('exit', () => { if (!this.closed && !this.failure) this.fail(new Error('Verification worker exited unexpectedly.')) })
        this.slots.push(created)
      }
      slot.job = this.queue.shift()!
      try { slot.worker.postMessage(slot.job.path) }
      catch (error) { this.fail(error as Error); return }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.slots.map(slot => slot.worker.terminate()))
  }
}

/** Drain all active tasks before propagating failures; never leave disk jobs running. */
export async function mapBounded<T, R>(items: readonly T[], concurrency: number, action: (item: T, index: number) => Promise<R>): Promise<R[]> {
  let cursor = 0
  let failed = false
  const results: R[] = new Array(items.length)
  const jobs = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++
      try { results[index] = await action(items[index], index) }
      catch (error) { failed = true; throw error }
    }
  })
  const settled = await Promise.allSettled(jobs)
  for (const job of settled) if (job.status === 'rejected') throw job.reason
  return results
}
