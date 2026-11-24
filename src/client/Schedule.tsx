import { useEffect, useRef, useState } from 'react';
import { mountSchedule } from './schedule-native';
import { useTranslation } from './preferences';
import { openScheduleSync } from './schedule-sync';

export function Schedule({ largeText, remote = false }: { largeText: boolean; remote?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const t = useTranslation();
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(remote);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let canceled = false;
    let dispose: (() => void) | undefined;
    let sync: Awaited<ReturnType<typeof openScheduleSync>> | undefined;
    setLoadError(''); setLoading(remote);
    void (async () => {
      try {
        if (remote) sync = await openScheduleSync();
        if (canceled || !host.current) { sync?.dispose(); return; }
        dispose = mountSchedule(host.current, sync?.storage);
        sync?.setStatusListener((message, error) => {
          const root = host.current?.shadowRoot;
          const status = root?.querySelector<HTMLElement>('#save-status');
          const notice = root?.querySelector<HTMLElement>('#storage-notice');
          if (status) { status.textContent = message; status.classList.toggle('error', error); }
          if (notice) { notice.textContent = error ? message : ''; notice.hidden = !error; }
        });
        setLoading(false);
      } catch (error) { if (!canceled) { setLoadError((error as Error).message); setLoading(false); } }
    })();
    return () => { canceled = true; dispose?.(); sync?.dispose(); };
  }, [remote, attempt]);
  useEffect(() => {
    if (!host.current) return;
    const parent = getComputedStyle(document.documentElement);
    for (const name of ['--paper', '--white', '--ink', '--muted', '--green', '--control', '--line']) {
      host.current.style.setProperty(name, parent.getPropertyValue(name));
    }
  }, [largeText]);
  return <section className="schedule-page">
    <h1 className="schedule-route-title" tabIndex={-1}>{t('日程表', 'スケジュール', 'Schedule')}</h1>
    {loading && <p role="status">{t('正在读取服务器日程…', 'スケジュールを読み込み中…', 'Loading your schedule…')}</p>}
    {loadError && <div role="alert">{loadError}<button className="tool-button" onClick={() => setAttempt(value => value + 1)}>{t('重试', '再試行', 'Retry')}</button></div>}
    <div ref={host} className={`schedule-native${largeText ? ' large-text' : ''}`} aria-label={t('可编辑周计划', '編集できる週間プラン', 'Editable weekly planner')}/>
  </section>;
}
