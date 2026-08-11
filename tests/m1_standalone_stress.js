import { installBadMacInterceptor } from '../src/auth/badMacInterceptor.js';

let purgeCount = 0;
let purgeAllCount = 0;

const mockPurgeCorruptKey = async () => { purgeCount++; };
const mockGetSessionId = () => 'standalone_session';
const mockPurgeAllForJid = async () => { purgeAllCount++; };

installBadMacInterceptor(mockPurgeCorruptKey, mockGetSessionId, mockPurgeAllForJid);

console.log('START_STRESS_TEST');

// Fire 150 unhandled promise rejections natively without .catch()
for (let i = 0; i < 150; i++) {
  const errType = i % 4;
  let err;
  if (errType === 0) {
    err = new Error('SessionError: No session record');
  } else if (errType === 1) {
    err = new Error('SessionError: No matching sessions found for message');
  } else if (errType === 2) {
    err = new Error("unexpected error in 'init queries' (timed out)");
  } else {
    err = new Error('Bad MAC in decryption pipeline');
  }
  Promise.reject(err);
}

// Keep event loop alive for 300ms to allow all microtasks and setImmediate to process
setTimeout(() => {
  console.log(`COMPLETED_STRESS_TEST: purges=${purgeCount}, purgeAlls=${purgeAllCount}`);
  process.exit(0);
}, 300);
