// Operator tool: default is read-only. Credentials remain outside the repository.
import { randomUUID } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROFILE = path.join(homedir(), '.ssh', 'languagemaster-deploy.json');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

export function validateProfile(value) {
  if (value?.host !== '8.133.242.232' || !['root', 'admin'].includes(value?.user) || value?.runtime !== '/opt/nihongo'
    || typeof value?.identityFile !== 'string' || !path.isAbsolute(value.identityFile)) throw new Error('Invalid deployment profile.');
  return value;
}

function command(program, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostic = '';
    child.stdout.on('data', value => { output += value; if (output.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${program} failed (${code}): ${diagnostic.trim()}`)));
    child.stdin.end(input);
  });
}

export function validateArchivePaths(names, listing) {
  if (!names.length || new Set(names).size !== names.length || names.some(name =>
    !name || /[\\\r\n]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')
    || /(^|\/)(data|server-data|recordings|node_modules|\.git|\.ssh|\.codex)(\/|$)/.test(name)
    || /(^|\/)\.env$|\.(?:sqlite(?:3)?(?:-wal|-shm)?|db(?:-wal|-shm)?|pem|key|p12|pfx)$/i.test(name))) throw new Error('Unsafe archive paths.');
  if (listing.split(/\r?\n/).length !== names.length || listing.split(/\r?\n/).some(line => !line.startsWith('-'))) throw new Error('Only regular files may be deployed.');
  if (!names.includes('deploy/update-session-release.sh') || !names.includes('package.json')) throw new Error('Missing release updater.');
}

export const repositoryUrl = 'https://github.com/MAXGUAN-Game/minnanonihongo_helper.git';

export function validateGitRelease({ commit, head, remoteHead, dirty }) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Use a full Git commit SHA; archive deployment is disabled.');
  if (head !== commit) throw new Error('Run from the exact validated release checkout.');
  if (dirty) throw new Error('Release checkout has uncommitted changes. Use a clean isolated checkout.');
  if (remoteHead !== commit) throw new Error('Push this commit to origin/main before deployment.');
  return commit;
}

export function updateScript({ commit, version, unit, syncOnly = false }) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^\d+\.\d+\.\d+$/.test(version)
    || !/^nihongo-update-\d+-[a-f0-9]{8}$/.test(unit)) throw new Error('Invalid Git release identity.');
  return `set -euo pipefail
umask 022
export GIT_TERMINAL_PROMPT=0
repo=/opt/nihongo-git
if test ! -e "$repo"; then
  git clone --depth 1 --branch main --single-branch '${repositoryUrl}' "$repo" </dev/null
fi
test -d "$repo/.git"
test ! -L "$repo"
test "$(git -C "$repo" remote get-url origin)" = '${repositoryUrl}'
test "$(git -C "$repo" symbolic-ref --short HEAD)" = main
test -z "$(git -C "$repo" status --porcelain --untracked-files=normal)"
git -C "$repo" pull --ff-only origin main </dev/null
test "$(git -C "$repo" rev-parse HEAD)" = '${commit}'
test "$(node -p 'require(process.argv[1]).version' "$repo/package.json")" = '${version}'
printf 'GIT_VERIFIED %s\\n' '${commit}'
${syncOnly ? `printf 'GIT_SYNCED %s (application unchanged)\\n' '${commit}'` : `systemd-run --unit='${unit}' --collect --service-type=exec --property=UMask=0077 \\
  --setenv=RELEASE_COMMIT='${commit}' \\
  --property=TimeoutStopSec=300 --property=StandardOutput=append:/opt/nihongo/${unit}.log \\
  --property=StandardError=inherit /usr/bin/bash "$repo/deploy/update-session-release.sh" /opt/nihongo`}
`;
}

async function main() {
  const profile = validateProfile(JSON.parse(await readFile(PROFILE, 'utf8')));
  const key = await lstat(profile.identityFile);
  if (!key.isFile() || key.isSymbolicLink()) throw new Error('Expected a regular dedicated SSH private key.');
  const target = `${profile.user}@${profile.host}`;
  const remote = script => command('ssh', [...options, '-i', profile.identityFile, target,
    profile.user === 'root' ? 'bash -s' : 'sudo -n bash -s'], script);
  const [action = '--check', argument, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments.');
  if (action === '--check' && !argument) {
    console.log(await remote(`set -euo pipefail
cd /opt/nihongo
test -d server-data
test ! -L server-data
docker compose ps
docker compose exec -T app node -p '"REMOTE_VERSION="+require("./package.json").version' </dev/null
`));
  } else if ((action === '--deploy' || action === '--sync') && argument) {
    if (!/^[a-f0-9]{40}$/.test(argument)) throw new Error('Use a full pushed Git commit SHA; archive deployment is disabled.');
    const [head, dirty, remoteRef, localOrigin] = await Promise.all([
      command('git', ['rev-parse', 'HEAD']), command('git', ['status', '--porcelain', '--untracked-files=normal']),
      command('git', ['ls-remote', 'origin', 'refs/heads/main']), command('git', ['remote', 'get-url', 'origin']),
    ]);
    if (localOrigin !== repositoryUrl) throw new Error('Unexpected Git origin.');
    const commit = validateGitRelease({ commit: argument, head, dirty, remoteHead: remoteRef.split(/\s+/)[0] });
    const version = JSON.parse(await command('git', ['show', `${commit}:package.json`])).version;
    const unit = `nihongo-update-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const syncOnly = action === '--sync';
    console.log(await remote(updateScript({ commit, version, unit, syncOnly })));
    console.log(JSON.stringify({ started: !syncOnly, synced: syncOnly, commit, version, ...(syncOnly ? {} : { unit, log: `/opt/nihongo/${unit}.log` }) }));
  } else if (action === '--status' && /^nihongo-update-\d+-[a-f0-9]{8}$/.test(argument ?? '')) {
    console.log(await remote(`set -euo pipefail
systemctl show '${argument}' --property=ActiveState,SubState,Result,ExecMainStatus || true
if test -f '/opt/nihongo/${argument}.log'; then tail -n 80 '/opt/nihongo/${argument}.log'; fi
`));
  } else throw new Error('Usage: remote-deploy.mjs [--check | --sync COMMIT | --deploy COMMIT | --status UNIT]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
