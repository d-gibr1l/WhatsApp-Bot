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

test('Core dispatch: silently ignores lone prefix or dot without replying or reacting', async () => {
  let replied = false;
  let reacted = false;
  const mockHooper = {
    decodeJid: async (jid) => jid,
    sendMessage: async () => { reacted = true; },
    user: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' }
  };
  const mockMsg = {
    text: '.',
    sender: 'user@s.whatsapp.net',
    from: 'user@s.whatsapp.net',
    isGroup: false,
    reply: () => { replied = true; }
  };
  const core = (await import('../Core.js')).default;
  await core(mockHooper, mockMsg, new Map());
  assert.equal(replied, false);
  assert.equal(reacted, false);
});

function viewOnceHarness({ sender, text, quotedOverrides = {} }) {
  const sent = [];
  let downloads = 0;
  const hooper = {
    decodeJid: async (jid) => jid,
    sendMessage: async (jid, content) => { sent.push({ jid, content }); },
    downloadMediaMessage: async () => { downloads++; return Buffer.from('media'); },
    user: { id: '2340000000001@s.whatsapp.net', lid: '2340000000001@lid' },
  };
  const m = {
    text,
    type: 'extendedTextMessage',
    message: { extendedTextMessage: { contextInfo: null } },
    sender,
    from: '2342222222222@s.whatsapp.net',
    isGroup: false,
    reply: () => {},
    quoted: {
      type: 'imageMessage',
      msg: { mimetype: 'image/jpeg', viewOnce: true, caption: 'secret' },
      sender: '2342222222222@s.whatsapp.net',
      ...quotedOverrides,
    },
  };
  return { hooper, m, sent, downloads: () => downloads };
}

test('Core dispatch: owner replying with 👀 to a View Once saves it to their DM', async () => {
  global.viewOnceEmojis = ['👀'];
  const { hooper, m, sent, downloads } = viewOnceHarness({ sender: '2340000000001@s.whatsapp.net', text: '👀' });
  const core = (await import('../Core.js')).default;
  await core(hooper, m, new Map());
  assert.equal(downloads(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '2340000000001@s.whatsapp.net');
  assert.ok(sent[0].content.image);
  assert.match(sent[0].content.caption, /viewonce saved from @2342222222222/);
});

test('Core dispatch: View Once emoji trigger ignores non-owners, other emojis and non-media replies', async () => {
  const core = (await import('../Core.js')).default;
  global.viewOnceEmojis = ['👀'];

  const stranger = viewOnceHarness({ sender: '2341111111111@s.whatsapp.net', text: '👀' });
  await core(stranger.hooper, stranger.m, new Map());
  assert.equal(stranger.downloads(), 0);

  const wrongEmoji = viewOnceHarness({ sender: '2340000000001@s.whatsapp.net', text: '🔥' });
  await core(wrongEmoji.hooper, wrongEmoji.m, new Map());
  assert.equal(wrongEmoji.downloads(), 0);

  const quotedText = viewOnceHarness({
    sender: '2340000000001@s.whatsapp.net',
    text: '👀',
    quotedOverrides: { type: 'conversation', msg: undefined },
  });
  await core(quotedText.hooper, quotedText.m, new Map());
  assert.equal(quotedText.downloads(), 0);

  // The viewOnce flag is not reliably present on a quoted copy — must still save.
  const noFlag = viewOnceHarness({
    sender: '2340000000001@s.whatsapp.net',
    text: '👀',
    quotedOverrides: { msg: { mimetype: 'video/mp4' }, type: 'videoMessage' },
  });
  await core(noFlag.hooper, noFlag.m, new Map());
  assert.equal(noFlag.downloads(), 1);
  assert.ok(noFlag.sent[0].content.video);

  global.viewOnceEmojis = ['🔥'];
  const custom = viewOnceHarness({ sender: '2340000000001@s.whatsapp.net', text: '🔥' });
  await core(custom.hooper, custom.m, new Map());
  assert.equal(custom.downloads(), 1);

  global.viewOnceEmojis = [];
  const disabled = viewOnceHarness({ sender: '2340000000001@s.whatsapp.net', text: '👀' });
  await core(disabled.hooper, disabled.m, new Map());
  assert.equal(disabled.downloads(), 0);
});

test('Core dispatch: 👀 reply with NO quoted content resolves the View Once from the cache by id', async () => {
  const { rememberViewOnce } = await import('../System/ViewOnceSaver.js');
  const core = (await import('../Core.js')).default;
  global.viewOnceEmojis = ['👀'];

  rememberViewOnce({
    key: { id: 'VO-CACHED-1', fromMe: true, remoteJid: '2342222222222@s.whatsapp.net' },
    message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true, caption: 'cap' } } } },
  });

  const h = viewOnceHarness({ sender: '2340000000001@s.whatsapp.net', text: '👀' });
  h.m.quoted = null;
  h.m.msg = { contextInfo: { stanzaId: 'VO-CACHED-1' } };
  await core(h.hooper, h.m, new Map());
  assert.equal(h.downloads(), 1);
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].content.image);
  assert.equal(h.sent[0].content.caption, ['viewonce saved from @2340000000001', '', 'cap'].join('\n'));

  // Unknown id or a plain (non-reply) 👀 must be ignored and not swallowed.
  const unknown = viewOnceHarness({ sender: '2340000000001@s.whatsapp.net', text: '👀' });
  unknown.m.quoted = null;
  unknown.m.msg = { contextInfo: { stanzaId: 'NOT-CACHED' } };
  await core(unknown.hooper, unknown.m, new Map());
  assert.equal(unknown.downloads(), 0);

  const plain = viewOnceHarness({ sender: '2340000000001@s.whatsapp.net', text: '👀' });
  plain.m.quoted = null;
  await core(plain.hooper, plain.m, new Map());
  assert.equal(plain.downloads(), 0);
});

test('rememberViewOnce: only keeps view-once messages', async () => {
  const { rememberViewOnce, saveViewOnce } = await import('../System/ViewOnceSaver.js');
  rememberViewOnce({ key: { id: 'NORMAL-1' }, message: { imageMessage: { mimetype: 'image/jpeg' } } });
  const sent = [];
  const hooper = { downloadMediaMessage: async () => Buffer.from('x'), sendMessage: async (...a) => sent.push(a) };
  const handled = await saveViewOnce(hooper, { sender: 'a@s.whatsapp.net', msg: { contextInfo: { stanzaId: 'NORMAL-1' } }, quoted: null });
  assert.equal(handled, false);
  assert.equal(sent.length, 0);

  rememberViewOnce({ key: { id: 'FLAGGED-1', participant: '2349@s.whatsapp.net' }, message: { videoMessage: { mimetype: 'video/mp4', viewOnce: true } } });
  const ok = await saveViewOnce(hooper, { sender: 'a@s.whatsapp.net', msg: { contextInfo: { stanzaId: 'FLAGGED-1' } }, quoted: null });
  assert.equal(ok, true);
  assert.ok(sent[0][1].video);
});

test.after(async () => {
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});
