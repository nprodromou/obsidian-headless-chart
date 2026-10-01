// One-line structured-enough logging to stdout; kubectl logs is the sink.

export function log(component, msg) {
  process.stdout.write(`${new Date().toISOString()} [${component}] ${msg}\n`);
}

export function fail(component, msg, code = 1) {
  process.stderr.write(`${new Date().toISOString()} [${component}] ERROR: ${msg}\n`);
  process.exit(code);
}
