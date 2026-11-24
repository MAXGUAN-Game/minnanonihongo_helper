import { describe, expect, it } from 'vitest';
import { validateProfile, validateArchivePaths, validateGitRelease, updateScript } from '../scripts/remote-deploy.mjs';
import { resolve } from 'node:path';

describe('operator remote deployment', () => {
  it('pins the intended server and runtime and accepts only dedicated absolute key paths', () => {
    const profile = { host: '8.133.242.232', user: 'admin', runtime: '/opt/nihongo', identityFile: resolve('test-key') };
    expect(validateProfile(profile)).toEqual(profile);
    for (const patch of [{ host: '118.178.178.123' }, { user: 'admin; whoami' }, { runtime: '/tmp' }, { identityFile: 'relative' }]) {
      expect(() => validateProfile({ ...profile, ...patch })).toThrow();
    }
  });
  it('rejects database, credentials, traversal, duplicate and linked archive entries', () => {
    const names = ['package.json', 'deploy/update-session-release.sh'];
    expect(() => validateArchivePaths(names, '- regular\n- regular')).not.toThrow();
    for (const name of ['../evil', '/etc/passwd', 'C:/private', '.env', 'src/.env', 'key.pem', 'data/record', 'nihongo.sqlite-wal', 'server-data/x', 'package.json']) {
      expect(() => validateArchivePaths([...names, name], '- file\n- file\n- file')).toThrow();
    }
    expect(() => validateArchivePaths(names, '- file\nl symlink')).toThrow();
  });
  it('refuses dirty, unpushed, abbreviated and mismatched release checkouts', () => {
    const input = { commit: 'a'.repeat(40), head: 'a'.repeat(40), remoteHead: 'a'.repeat(40), dirty: '' };
    expect(validateGitRelease(input)).toBe(input.commit);
    for (const patch of [{ commit: 'a'.repeat(7) }, { commit: 'releases/release.tar.gz' }, { head: 'b'.repeat(40) }, { remoteHead: 'b'.repeat(40) }, { dirty: ' M src/server/app.ts' }]) {
      expect(() => validateGitRelease({ ...input, ...patch })).toThrow();
    }
  });
  it('pulls Git fast-forward and verifies the exact pushed commit before starting the protected updater', () => {
    const input = { commit: 'a'.repeat(40), version: '1.12.0', unit: 'nihongo-update-12345678-abcdef12' };
    const script = updateScript(input);
    expect(script).toContain('repo=/opt/nihongo-git');
    expect(script).toContain('git -C "$repo" pull --ff-only origin main');
    expect(script.indexOf('status --porcelain')).toBeLessThan(script.indexOf('pull --ff-only'));
    expect(script.indexOf('pull --ff-only')).toBeLessThan(script.indexOf('rev-parse HEAD'));
    expect(script.indexOf('rev-parse HEAD')).toBeLessThan(script.indexOf('systemd-run'));
    expect(script).toContain(`--setenv=RELEASE_COMMIT='${input.commit}'`);
    expect(script).toContain('"$repo/deploy/update-session-release.sh" /opt/nihongo');
    expect(script).not.toMatch(/tar -x|scp |reset |clean |cp /);
    expect(updateScript({ ...input, syncOnly: true })).toContain('GIT_SYNCED');
    expect(updateScript({ ...input, syncOnly: true })).not.toContain('systemd-run');
    for (const patch of [{ commit: 'bad;id' }, { version: '1.4.3;id' }, { unit: 'x\nid' }]) {
      expect(() => updateScript({ ...input, ...patch })).toThrow();
    }
  });
});
