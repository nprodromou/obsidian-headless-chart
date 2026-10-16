import { spawn, spawnSync } from 'node:child_process';

// Run a command synchronously and capture output. Never throws on a non-zero
// exit; callers decide what a failure means. `input` is written to stdin, which
// is how secrets reach a child: never argv, where any process in the pod can
// read them.
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

// The async form, for callers that must keep serving HTTP while the child runs.
// Same result shape as run(), plus timedOut. stdin always gets `input` (empty by
// default) and EOF, so a child that prompts never waits on a terminal. Env keys
// set to undefined in opts.env are removed from the child's environment.
//
// The child leads its own process group, and a timeout kills the whole group:
// `git fetch` hands the network to git-remote-https or ssh, which would keep
// hanging (and holding the output pipes open) after git itself was killed.
// Output past maxBuffer fails the call rather than returning a truncated list.
export function runAsync(cmd, args, { input = '', timeoutMs = 60000, maxBuffer = 1024 * 1024, env = {}, cwd } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ ok: false, status: null, stdout: '', stderr: '', error, timedOut: false });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let overflow = false;
    const collect = (buf) => (chunk) => {
      size += chunk.length;
      if (size <= maxBuffer) buf.push(chunk);
      else overflow = true;
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    let timedOut = false;
    let error;
    let done = false;
    let grace;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({
        ok: status === 0 && !timedOut && !overflow,
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: error || (overflow ? new Error(`output exceeded ${maxBuffer} bytes`) : undefined),
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // Something outside the group may still hold a pipe; don't wait on it.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, 5000);
    }, timeoutMs);
    child.on('error', (e) => { error = e; });
    child.on('close', (status) => finish(status));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}
