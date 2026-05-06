const pty = require('node:child_process').spawn('npx', ['drizzle-kit', 'generate'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

pty.stdout.on('data', (data) => {
  process.stdout.write(data);
  if (data.toString().includes('Is ai_activity_log table created')) {
    pty.stdin.write('\r');
  }
});

pty.stderr.on('data', (data) => {
  process.stderr.write(data);
});

pty.on('close', (code) => {
  process.exit(code);
});
