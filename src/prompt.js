/** Reads one line from the console. `mask` is the character echoed per typed character ('' echoes nothing, undefined echoes the text). */
export function ask(prompt, mask) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') process.exit(1); // Ctrl+C
        if (c === '\b' || c === '\x7f') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (c >= ' ') {
          value += c;
          process.stdout.write(mask ?? c);
        }
      }
    };
    stdin.on('data', onData);
  });
}

export const askPassword = (prompt) => ask(prompt, '*');
