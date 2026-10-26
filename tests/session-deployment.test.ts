import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateCaddy, migrateCompose } from '../deploy/migrate-session-auth.mjs';

describe('session deployment migration', () => {
  it('preserves custom IP TLS, proxy token and data paths while moving auth to app', () => {
    const current = readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
    const legacy = current.replace('# The application verifies persistent version-bound sessions; proxy and origin checks remain mandatory.', '# legacy')
      .replace('\troute {', '\ttls {\n\t\tissuer acme { profile shortlived }\n\t}\n\troute {\n\t\tbasic_auth {\n\t\t\t{$APP_AUTH_USER} {$APP_AUTH_HASH}\n\t\t}');
    const migrated = migrateCaddy(legacy);
    expect(migrated).not.toContain('basic_auth'); expect(migrated).toContain('profile shortlived'); expect(migrated).toContain('X-Nihongo-Proxy {$APP_PROXY_TOKEN}');
    expect(migrateCaddy(migrated)).toBe(migrated);
    expect(migrateCaddy(current)).toBe(current);
    for (const name of ['compose.yaml', 'compose.shared.yaml']) {
      const text = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
      const legacyCompose = text.replace(/      APP_AUTH_USER: "\$\{APP_AUTH_USER:\?Configure website login first\}"\n      APP_AUTH_HASH: "\$\{APP_AUTH_HASH:\?Configure website login first\}"\n/, '');
      const result = migrateCompose(legacyCompose);
      expect(result).toContain('./server-data:/app/data'); expect(result).toContain('APP_AUTH_HASH:'); expect(migrateCompose(result)).toBe(result);
    }
  });
  it('refuses unknown authentication and mount layouts', () => {
    expect(() => migrateCaddy('example.com { basic_auth { other hash } }')).toThrow();
    expect(() => migrateCompose('services:\n  app:\n    volumes: []\n  caddy:\n')).toThrow();
  });
});
