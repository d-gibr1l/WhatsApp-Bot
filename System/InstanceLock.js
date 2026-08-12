import mongoose from "mongoose";
import crypto from "crypto";

const lockSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  instanceId: { type: String, required: true },
  lastHeartbeat: { type: Date, required: true },
});

// Avoid re-compiling the model if already defined
const LockModel = mongoose.models.Lock || mongoose.model("Lock", lockSchema);

export default class InstanceLock {
  constructor() {
    this.instanceId = crypto.randomUUID();
    this.heartbeatTimer = null;
    this.lockId = "active_whatsapp_socket";
  }

  /**
   * Attempts to claim the deployment lock.
   * @returns {Promise<{ requiresDelay: boolean }>} True if a recent lock exists, meaning we should delay.
   */
  async claimLock() {
    // 1. Check existing lock
    const currentLock = await LockModel.findById(this.lockId);
    let requiresDelay = false;

    if (currentLock) {
      const msSinceLastHeartbeat = Date.now() - currentLock.lastHeartbeat.getTime();
      if (msSinceLastHeartbeat < 10000) {
        // Heartbeat is active (less than 10s old). A deployment is likely happening.
        requiresDelay = true;
      }
    }

    // 2. Overwrite the lock with our instanceId
    await LockModel.updateOne(
      { _id: this.lockId },
      { $set: { instanceId: this.instanceId, lastHeartbeat: new Date() } },
      { upsert: true }
    );

    return { requiresDelay };
  }

  /**
   * Starts the 3-second heartbeat.
   * @param {Function} onStolen Callback executed if the lock is stolen by a new deployment.
   */
  startCheck(onStolen) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(async () => {
      try {
        // Attempt to update the heartbeat ONLY if we still own the lock
        const doc = await LockModel.findOneAndUpdate(
          { _id: this.lockId, instanceId: this.instanceId },
          { $set: { lastHeartbeat: new Date() } }
        );

        // If no document was updated, we lost the lock.
        if (!doc) {
          clearInterval(this.heartbeatTimer);
          onStolen();
        }
      } catch (err) {
        // Ignore network blips. If MongoDB goes down, we shouldn't kill the bot immediately.
        // We only die if another instance definitively stole the lock.
      }
    }, 3000);
  }

  /**
   * Releases the lock on graceful shutdown.
   */
  async releaseLock() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      await LockModel.deleteOne({ _id: this.lockId, instanceId: this.instanceId });
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}
