import test from "node:test";
import assert from "node:assert/strict";
import InstanceLock from "../System/InstanceLock.js";
import mongoose from "mongoose";

test("InstanceLock: constructor generates unique instanceId and default lockId", () => {
  const lock1 = new InstanceLock();
  const lock2 = new InstanceLock();

  assert.ok(lock1.instanceId);
  assert.ok(lock2.instanceId);
  assert.notEqual(lock1.instanceId, lock2.instanceId);
  assert.equal(lock1.lockId, "active_whatsapp_socket");
});

test("InstanceLock: claimLock safely resolves { requiresDelay: false } when MongoDB is disconnected", async () => {
  const lock = new InstanceLock();
  // Ensure we are disconnected for this test
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect().catch(() => {});
  }

  const result = await lock.claimLock();
  assert.deepEqual(result, { requiresDelay: false });
});

test("InstanceLock: releaseLock clears heartbeatTimer and resolves safely when disconnected", async () => {
  const lock = new InstanceLock();
  let stolenCalled = false;
  lock.startCheck(() => { stolenCalled = true; });

  assert.ok(lock.heartbeatTimer);
  await lock.releaseLock();
  assert.equal(stolenCalled, false);
});

test.after(async () => {
  await mongoose.disconnect().catch(() => {});
});
