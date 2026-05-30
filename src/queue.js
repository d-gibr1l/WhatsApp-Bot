/**
 * A simple sequential queue manager to replace `makeLimit(5)`.
 * It maintains a separate FIFO queue for each chat (JID) so that
 * messages from different chats are processed concurrently without bounds,
 * but messages within the SAME chat are strictly sequential to maintain order.
 */
export class ChatQueueManager {
  constructor() {
    this.queues = new Map();
    this.active = new Set();
  }

  /**
   * Enqueues a task for a specific chat.
   * @param {string} jid The chat ID (e.g., remoteJid)
   * @param {Function} task A function that returns a Promise
   */
  enqueue(jid, task) {
    if (!this.queues.has(jid)) {
      this.queues.set(jid, []);
    }
    this.queues.get(jid).push(task);
    this.processNext(jid);
  }

  async processNext(jid) {
    // If this chat is already actively processing a message, do nothing
    if (this.active.has(jid)) return;

    const queue = this.queues.get(jid);
    if (!queue || queue.length === 0) {
      this.queues.delete(jid);
      return;
    }

    this.active.add(jid);
    const task = queue.shift();

    try {
      await task();
    } catch (err) {
      console.error(`Error processing queue for ${jid}:`, err);
    } finally {
      this.active.delete(jid);
      // Process next item in the queue for this chat
      this.processNext(jid);
    }
  }
}

export const chatQueue = new ChatQueueManager();

/**
 * A concurrency semaphore for heavy tasks (e.g., yt-dlp child processes, AI generation)
 * to prevent Render OOM crashes.
 */
export class HeavyTaskQueue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
  }

  async execute(task) {
    if (this.active >= this.concurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

export const heavyQueue = new HeavyTaskQueue(3);
