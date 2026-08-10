import { BufferJSON } from '@whiskeysockets/baileys';
console.log('serialize:', JSON.stringify(Buffer.from('hello'), BufferJSON.replacer));
console.log('deserialize:', JSON.parse('{"type":"Buffer","data":[104,101,108,108,111]}', BufferJSON.reviver));
