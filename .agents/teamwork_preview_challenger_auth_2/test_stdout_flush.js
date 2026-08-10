import { spawn } from 'child_process';

const code = `
  // Force stdout to flush synchronously on every write
  const origWrite = process.stdout.write;
  process.stdout.write = function(...args) {
    const res = origWrite.apply(process.stdout, args);
    return res;
  };
  
  console.log("[TEST] Importing index.js now...");
  import('./index.js').catch(console.error);
`;

const child = spawn('node', ['--input-type=module', '-e', code], {
  cwd: 'C:\\Users\\domin\\Desktop\\my-whatsapp-bot-main',
  env: { ...process.env, PORT: '3098' }
});

child.stdout.on('data', d => console.log(`[STDOUT]: ${d.toString().trim()}`));
child.stderr.on('data', d => console.error(`[STDERR]: ${d.toString().trim()}`));

setTimeout(() => child.kill('SIGTERM'), 6000);
