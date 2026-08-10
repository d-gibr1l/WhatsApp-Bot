import { spawn } from 'child_process';

console.log("=== EMPIRICAL VERIFICATION: Bot Bootup Check ===");
console.log("Executing: node -e \"import('./index.js').catch(console.error)\"\n");

const child = spawn('node', ['-e', "import('./index.js').catch(console.error)"], {
  cwd: 'C:\\Users\\domin\\Desktop\\my-whatsapp-bot-main',
  env: { ...process.env, PORT: '3099' } // use non-conflicting port 3099
});

let stdout = '';
let stderr = '';

child.stdout.on('data', d => {
  const str = d.toString();
  stdout += str;
  process.stdout.write(`[STDOUT] ${str}`);
});

child.stderr.on('data', d => {
  const str = d.toString();
  stderr += str;
  process.stderr.write(`[STDERR] ${str}`);
});

// Run for 10 seconds to allow jitter and initial reconnect attempt
setTimeout(() => {
  console.log("\n--- Terminating Bootup Test Process after 10s ---");
  child.kill('SIGTERM');
}, 10000);

child.on('close', (code, signal) => {
  console.log(`\n=== Bootup Process Closed (exit code: ${code}, signal: ${signal}) ===`);
  console.log(`Total stdout lines: ${stdout.split('\n').filter(Boolean).length}`);
  console.log(`Total stderr lines: ${stderr.split('\n').filter(Boolean).length}`);
  
  if (stderr.includes('Error') || stderr.includes('Exception') || stderr.includes('ERR')) {
    console.log("⚠️ Stderr contains errors/warnings during bootup.");
  } else {
    console.log("✅ Bootup completed initial phase without synchronous fatal errors.");
  }
});
