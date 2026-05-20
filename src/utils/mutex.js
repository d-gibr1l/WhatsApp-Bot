import { EventEmitter } from 'events';

class Mutex {
  constructor() {
    this.locks = new Map();
    this.emitter = new EventEmitter();
  }

  async acquire(key) {
    while (this.locks.get(key)) {
      await new Promise(resolve => this.emitter.once(`release:${key}`, resolve));
    }
    this.locks.set(key, true);
  }

  release(key) {
    this.locks.delete(key);
    this.emitter.emit(`release:${key}`);
  }

  async runExclusive(key, task) {
    await this.acquire(key);
    try {
      return await task();
    } finally {
      this.release(key);
    }
  }
}

export const mutex = new Mutex();