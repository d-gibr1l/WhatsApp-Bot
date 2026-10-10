import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCachedGroupMetadata, invalidateGroupMetadata } from '../Core.js';

test('getCachedGroupMetadata: returns metadata and caches subsequent calls', async () => {
  let callCount = 0;
  const mockHooper = {
    groupMetadata: async (jid) => {
      callCount++;
      return { id: jid, subject: 'Test Group', participants: [{ id: '123@s.whatsapp.net' }] };
    }
  };

  const groupId = 'test-cache-group@g.us';
  invalidateGroupMetadata(groupId);

  const res1 = await getCachedGroupMetadata(mockHooper, groupId);
  assert.equal(res1.subject, 'Test Group');
  assert.equal(callCount, 1);

  // Second call should hit in-memory cache and not increment callCount
  const res2 = await getCachedGroupMetadata(mockHooper, groupId);
  assert.equal(res2.subject, 'Test Group');
  assert.equal(callCount, 1);

  // Invalidate cache
  invalidateGroupMetadata(groupId);

  // Third call should query Hooper.groupMetadata again
  const res3 = await getCachedGroupMetadata(mockHooper, groupId);
  assert.equal(res3.subject, 'Test Group');
  assert.equal(callCount, 2);
});

test('getCachedGroupMetadata: handles falsy JID safely', async () => {
  const res = await getCachedGroupMetadata({}, null);
  assert.deepEqual(res, {});
});

test.after(async () => {
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});
