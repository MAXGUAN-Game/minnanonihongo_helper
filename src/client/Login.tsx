import { useState } from 'react';
import { post } from './api';
import { Button } from './ui';
import { useTranslation } from './preferences';

export function Login({ onLogin }: { onLogin: () => void }) {
  const t = useTranslation();
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <main className="load-screen"><h1>{t('验证网站密码', 'ログイン')}</h1><p>{t('验证后，在下次正式版本更新前保持登录。', '次の正式アップデートまでログイン状態を維持します。')}</p>
    <form className="login-form" onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError('');
      try { await post('/auth/login', { username, password }); setPassword(''); onLogin(); }
      catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
    }}><label>{t('用户名', 'ユーザー名')}<input name="username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required disabled={busy}/></label>
      <label>{t('密码', 'パスワード')}<input name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy}/></label>
      {error && <p role="alert">{error}</p>}<Button type="submit" disabled={busy}>{busy ? t('正在验证……', '確認中…') : t('登录', 'ログイン')}</Button>
    </form></main>;
}
