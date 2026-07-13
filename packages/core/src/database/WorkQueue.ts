/**
 * Serializes database work. Strictly FIFO, one item at a time — readers are
 * not concurrent (a deliberate simplification; upstream promised concurrent
 * readers in docs but ran serial too). `db.read` therefore means "a
 * consistency window: no writer runs while this block does".
 *
 * Re-entrancy is NOT supported: calling db.write/db.read from inside a
 * running block deadlocks. Compose by calling plain functions inside one
 * block instead. (Database.batch does not enqueue — it asserts a writer is
 * already running — so batching inside a writer is fine.)
 */

interface WorkQueueItem {
  readonly work: () => Promise<unknown>
  readonly isWriter: boolean
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

export class WorkQueue {
  private queue: WorkQueueItem[] = []
  private executing = false

  get isWriterRunning(): boolean {
    return this.executing && this.queue[0]?.isWriter === true
  }

  enqueue<T>(work: () => Promise<T>, isWriter: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        work,
        isWriter,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      if (this.queue.length === 1) {
        void this.executeNext()
      }
    })
  }

  private async executeNext(): Promise<void> {
    const item = this.queue[0]
    if (!item) {
      return
    }
    this.executing = true
    try {
      item.resolve(await item.work())
    } catch (error) {
      item.reject(error)
    }
    this.executing = false
    this.queue.shift()
    if (this.queue.length > 0) {
      queueMicrotask(() => void this.executeNext())
    }
  }
}
