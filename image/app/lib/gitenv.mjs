// Git environment for the init and keeper containers.
//
// The pod runs with a read-only root filesystem and HOME on an emptyDir, so
// anything git wants in ~/.gitconfig or ~/.ssh is written here at start.

import fs from 'node:fs';
import path from 'node:path';
import { run, firstLine } from './proc.mjs';

export function setupGitEnv(cfg, env = process.env) {
  const home = env.HOME || '/tmp/home';
  fs.mkdirSync(home, { recursive: true });

  env.GIT_TERMINAL_PROMPT = '0';

  // HTTPS token: git asks GIT_ASKPASS for the username and the password.
  if (env.GIT_TOKEN) {
    env.GIT_ASKPASS = env.GIT_ASKPASS || '/app/bin/git-askpass.sh';
  }

  // SSH key: Secret volumes are root-owned, and ssh refuses a key that is group
  // readable, so copy it into HOME with 0600 first.
  if (env.GIT_SSH_KEY_FILE) {
    const sshDir = path.join(home, '.ssh');
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const key = path.join(sshDir, 'id_git');
    fs.copyFileSync(env.GIT_SSH_KEY_FILE, key);
    fs.chmodSync(key, 0o600);
    const knownHosts = env.GIT_SSH_KNOWN_HOSTS_FILE;
    const hostOpts = knownHosts
      ? `-o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=yes`
      : '-o StrictHostKeyChecking=accept-new';
    env.GIT_SSH_COMMAND = `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes ${hostOpts}`;
  }

  // LFS clean/smudge filters, with smudge skipped: checkouts produce pointers
  // and `git lfs pull` fills in content afterwards, so a slow LFS server never
  // blocks a fast-forward.
  if (cfg.lfs) {
    const res = run('git', ['lfs', 'install', '--skip-repo', '--skip-smudge'], { env });
    if (!res.ok) {
      throw new Error(`git lfs install failed: ${firstLine(res.stderr || res.stdout)}`);
    }
  }
  return env;
}

export function usesLfs(dir) {
  const res = run('git', ['-C', dir, 'grep', '-q', 'filter=lfs', 'HEAD', '--', '.gitattributes', '*/.gitattributes']);
  return res.ok;
}
