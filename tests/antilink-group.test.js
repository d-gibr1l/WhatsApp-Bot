import { test } from 'node:test';
import assert from 'node:assert/strict';
import groupPlugin from '../Plugins/group.js';

test('Antilink Regex: matches standard and schemeless invite/wa links', () => {
  const urlRegex = /(?:https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+)/gi;

  const standardHttp = 'Check this http://example.com/test';
  assert.equal(standardHttp.match(urlRegex)?.[0], 'http://example.com/test');

  const standardHttps = 'Join https://chat.whatsapp.com/ABC12345 now';
  assert.equal(standardHttps.match(urlRegex)?.[0], 'https://chat.whatsapp.com/ABC12345');

  const schemelessInvite = 'Join our group chat.whatsapp.com/XYZ98765 right now';
  assert.equal(schemelessInvite.match(urlRegex)?.[0], 'chat.whatsapp.com/XYZ98765');

  const waMeLink = 'Contact me at wa.me/1234567890 please';
  assert.equal(waMeLink.match(urlRegex)?.[0], 'wa.me/1234567890');

  const normalText = 'Hello everybody how are you doing today';
  assert.equal(normalText.match(urlRegex), null);
});

test('Group Plugin: rejects execution in private chats', async () => {
  let repliedMessage = '';
  let reactionEmoji = '';

  const mockMsg = {
    isGroup: false,
    reply: async (text) => {
      repliedMessage = text;
    }
  };

  const mockDoReact = async (emoji) => {
    reactionEmoji = emoji;
  };

  await groupPlugin.start({}, mockMsg, {
    inputCMD: 'demote',
    doReact: mockDoReact,
  });

  assert.equal(reactionEmoji, '❌');
  assert.equal(repliedMessage, '*This command can only be used in groups!*');
});

test.after(async () => {
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});
