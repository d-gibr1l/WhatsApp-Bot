import assert from 'node:assert/strict';
import { installBadMacInterceptor, uninstallBadMacInterceptor } from '../../src/auth/badMacInterceptor.js';

process.stdout.write('Testing Unhandled Rejection Interceptor behavior...\n');

let purged = [];
installBadMacInterceptor(
  async (type, id) => { purged.push({ type, id }); },
  () => 'test-sess',
  async (jid) => {}
);

const badMacErr = new Error('Bad MAC\n at async 551100000000.0 [as awaitable]');
process.emit('unhandledRejection', badMacErr);

await new Promise(r => setTimeout(r, 300));

assert.ok(purged.some(p => p.id === '551100000000.0'), 'Unhandled Bad MAC rejection should trigger key purge');

uninstallBadMacInterceptor();
process.stdout.write('PASSED: Unhandled Bad MAC Rejection correctly intercepted and purged\n');
