import { Login } from './Login';
import { translate } from './i18n';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, BookOpen, Check, ChevronLeft, Download, Headphones, Home, Leaf, Lightbulb, Map, MessageCircle, Mic, RotateCcw, Settings as SettingsIcon, ShieldCheck, Square, Upload, Volume2, X } from 'lucide-react';
import type { Bootstrap, Lesson, ReviewItem, Settings } from '../shared/types';
import { api, post } from './api';
import { useSpeech, type Speech } from './speech';
import { ArtPath, Button, Empty, Heading, Sentence } from './ui';
import { Study } from './Study';
import { CourseMap } from './CourseMap';
import { VoiceSettings } from './VoiceSettings';
import { AudioControls } from './AudioControls';
import { AudioAssessmentSettings } from './AudioAssessmentSettings';
import { Katakana } from './Katakana';
import { usePreferences, setPreferences, useTranslation } from './preferences';
import { Rocket, PanelLeftClose, PanelLeftOpen, Minimize2, Maximize2 } from 'lucide-react';
import './style.css';

type View = 'home' | 'lessons' | 'study' | 'review' | 'settings' | 'katakana';
function readView(): { view: View; lessonId: number | null } {
  const [name, number] = location.hash.replace('#', '').split('/');
  return { view: ['lessons', 'study', 'settings', 'katakana'].includes(name) ? name as View : 'lessons', lessonId: number && Number(number) >= 1 && Number(number) <= 50 ? Number(number) : null };
}
function App() {
  const preferences = usePreferences();
  const t = useTranslation();
  useEffect(() => {
    document.documentElement.lang = preferences.locale;
    document.title = preferences.immersive ? t('工作区', 'ワークスペース') : 'スーパーミンナノニホンゴ';
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.head.appendChild(document.createElement('link'));
    icon.rel = 'icon'; icon.type = 'image/svg+xml';
    icon.href = preferences.immersive ? '/workspace.svg' : '/favicon.svg';
  }, [preferences.locale, preferences.immersive]);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [route, setRoute] = useState(readView);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [welcome, setWelcome] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);
  useEffect(() => { const requireLogin = () => { setLoginRequired(true); setBootstrap(null); }; window.addEventListener('auth-required', requireLogin); return () => window.removeEventListener('auth-required', requireLogin); }, []);
  const notice = useCallback((text: string) => setMessage(text), []);
  const speech = useSpeech(notice);
  const refresh = useCallback(async () => { setBootstrap(await api<Bootstrap>('/bootstrap')); }, []);
  const load = useCallback(async () => { try { const [initial, content] = await Promise.all([api<Bootstrap>('/bootstrap'), api<Lesson[]>('/lessons')]); setBootstrap(initial); setLessons(content); setLoadError(''); } catch (error) { setLoadError((error as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const update = () => { speech.stop(); setRoute(readView()); setMessage(''); }; window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, [speech.stop]);
  useEffect(() => { document.documentElement.classList.toggle('large-text', Boolean(bootstrap?.settings.largeText)); }, [bootstrap?.settings.largeText]);
  const pageReady = Boolean(bootstrap && lessons.length && !loadError);
  useEffect(() => { if (!pageReady) return; const timer = setTimeout(() => document.querySelector<HTMLHeadingElement>('h1')?.focus({ preventScroll: true }), 30); return () => clearTimeout(timer); }, [route.view, route.lessonId, pageReady]);
  async function updateSettings(changes: Partial<Settings> & { apiKey?: string }) { const settings = await api<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(changes) }); setBootstrap(previous => previous ? { ...previous, settings } : previous); return settings; }
  function navigate(view: View, lessonId?: number) { speech.stop(); setMessage(''); location.hash = view + (lessonId ? '/' + lessonId : ''); window.scrollTo({ top: 0, behavior: 'instant' }); }
  async function selectLesson(id: number) { try { await updateSettings({ currentLessonId: id }); await refresh(); navigate('study', id); } catch (error) { notice((error as Error).message); } }
  if (loginRequired) return <Login onLogin={() => { setLoginRequired(false); setLoadError(''); void load(); }}/>;
  if (loadError) return <main className="load-screen"><span className="brand-mark"><Rocket/></span><h1>{translate("暂时没有连上学习服务")}</h1><p>{loadError}</p><p>{['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? '请先双击“一键启动”，再试一次。' : translate('请检查网络，稍后重新连接。')}</p><Button onClick={load}>{translate("重新连接")}<RotateCcw size={18}/></Button></main>;
  if (!bootstrap || !lessons.length) return <main className="load-screen" aria-busy="true"><span className="brand-mark"><Rocket/></span><h1>{translate("正在打开你的学习角落……")}</h1></main>;
  const settings = bootstrap.settings;
  const current = lessons.find(lesson => lesson.id === (route.lessonId || settings.currentLessonId)) || lessons[0];
  const homeLesson = lessons.find(lesson => lesson.id === settings.currentLessonId) || lessons[0];
  const navItems: { id: View; label: string; icon: typeof Home }[] = [{ id: 'lessons', label: t('50课地图', '50課マップ'), icon: Map }, { id: 'katakana', label: t('片假名', 'カタカナ'), icon: BookOpen }, { id: 'settings', label: t('设置', '設定'), icon: SettingsIcon }];
  return <div className={`app-layout ${preferences.collapsed ? 'sidebar-collapsed' : ''} ${preferences.immersive ? 'immersive' : ''}`}>
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>{t('跳到内容', '本文へ')}</a>
    <aside className="sidebar"><button className="brand" onClick={() => navigate('lessons')} aria-label={t('回到课程地图', '課マップへ')}><span className="brand-mark"><Rocket/></span><span><strong>スーパーミンナノニホンゴ</strong></span></button>
      <button className="tool-button sidebar-toggle" onClick={() => setPreferences({ collapsed: !preferences.collapsed })} aria-label={t(preferences.collapsed ? '展开目录' : '收拢目录', preferences.collapsed ? 'メニューを展開' : 'メニューを折りたたむ')}>{preferences.collapsed ? <PanelLeftOpen/> : <PanelLeftClose/>}</button>
      <nav aria-label={t('主导航', 'メインナビゲーション')}>{navItems.map(item => <button key={item.id} aria-label={item.label} title={item.label} className={route.view === item.id || item.id === 'lessons' && route.view === 'study' ? 'active' : ''} onClick={() => navigate(item.id)}><item.icon size={21}/><span>{item.label}</span></button>)}</nav>
    </aside>
    <div className="main-area"><header className="topbar"><span className="topbar-caption">スーパーミンナノニホンゴ</span><div className="topbar-actions">
      {preferences.immersive && <select aria-label={t('导航', 'ナビゲーション')} value={route.view === 'study' ? 'study' : route.view} onChange={event => navigate(event.target.value as View)}>{route.view === 'study' && <option value="study">{current.id}</option>}{navItems.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
      {bootstrap.deployment === 'web' && <button className="tool-button" onClick={() => void post('/auth/logout', {}).then(() => { speech.stop(); setLoginRequired(true); setBootstrap(null); }).catch(error => notice(error.message))}>{t('退出登录', 'ログアウト')}</button>}
      <select aria-label={t('界面语言', '表示言語')} value={preferences.locale} onChange={event => setPreferences({ locale: event.target.value as 'zh-CN' | 'ja-JP' })}><option value="zh-CN">中文</option><option value="ja-JP">日本語</option></select>
      <button className="tool-button large-text-toggle" aria-pressed={settings.largeText} onClick={() => void updateSettings({ largeText: !settings.largeText }).catch(error => notice(error.message))}>{t('大字', '文字サイズ')}</button>
      <button className="tool-button" aria-pressed={preferences.immersive} title={t(preferences.immersive ? '退出沉浸模式' : '沉浸模式', preferences.immersive ? '集中モードを終了' : '集中モード')} aria-label={t(preferences.immersive ? '退出沉浸模式' : '沉浸模式', preferences.immersive ? '集中モードを終了' : '集中モード')} onClick={() => setPreferences({ immersive: !preferences.immersive })}>{preferences.immersive ? <Maximize2 size={18}/> : <><Minimize2 size={18}/>{t('沉浸模式', '集中モード')}</>}</button>
    </div></header>
      <main id="main" className="page-content" tabIndex={-1}>
        {message && <div className="message-banner" role="status"><span>{message}</span><button aria-label={translate("关闭提示")} onClick={() => setMessage('')}><X size={20}/></button></div>}
        {route.view === 'katakana' && <Katakana/>}
        {route.view === 'lessons' && <CourseMap lessons={lessons} bootstrap={bootstrap} choose={selectLesson}/>}
        {route.view === 'study' && <><button className="text-button back-link" onClick={() => navigate('lessons')}><ChevronLeft size={17}/>回到课程地图</button><Heading eyebrow={`初级 ${current.volume === 1 ? 'Ⅰ' : 'Ⅱ'} · 第 ${String(current.id).padStart(2, '0')} 课`} title={current.title} description={current.canDo}/><Study key={current.id} lesson={current} bootstrap={bootstrap} speech={speech} notice={notice} refresh={refresh}/></>}
        {route.view === 'settings' && <SettingsPage bootstrap={bootstrap} lessons={lessons} update={updateSettings} refresh={refresh} speech={speech} notice={notice}/>}
      </main><footer className="app-footer"><span>{translate("一次一句，慢慢来。")}</span><span>{translate("原创练习 · 配合《大家的日语》第二版使用")}</span>{bootstrap.deployment === 'web' && bootstrap.publicSite?.icpNumber && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{bootstrap.publicSite.icpNumber}</a>}</footer>
    </div>
    {welcome && <Onboarding deployment={bootstrap.deployment} current={settings.currentLessonId} lessons={lessons} close={() => setWelcome(false)} complete={async (lessonId, key) => { await updateSettings({ currentLessonId: lessonId, setupComplete: true, ...(key ? { apiKey: key } : {}) }); setWelcome(false); await selectLesson(lessonId); }} notice={notice}/>}
  </div>;
}

function SettingsPage({ bootstrap, lessons, update, refresh, speech, notice }: { bootstrap: Bootstrap; lessons: Lesson[]; update: (changes: Partial<Settings> & { apiKey?: string }) => Promise<Settings>; refresh: () => Promise<void>; speech: Speech; notice: (text: string) => void }) {
  const [key, setKey] = useState(''); const [model, setModel] = useState(bootstrap.settings.model); const [pending, setPending] = useState(false); const [restoreFile, setRestoreFile] = useState<{ name: string; backup: unknown } | null>(null);
  const settings = bootstrap.settings;
  async function save() { setPending(true); try { await update({ model, ...(key.trim() ? { apiKey: key.trim() } : {}) }); setKey(''); notice(bootstrap.deployment === 'web' ? translate('设置已保存在你的服务器。') : translate('设置已保存在本机。')); } catch (error) { notice((error as Error).message); } finally { setPending(false); } }
  async function testMic() { try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); notice('麦克风权限正常。到口语练习录一句日语，检查听音反馈。'); } catch { notice('未能打开麦克风。请检查浏览器和系统的麦克风权限；网站需要使用 HTTPS 地址。'); } }
  async function downloadBackup() { try { const backup = await api('/backup'); const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `日语学习记录-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); } catch (error) { notice((error as Error).message); } }
  return <><Heading eyebrow={translate("你的学习偏好")} title={<>{translate("调到")}<em>{translate("适合你的样子。")}</em></>} description={bootstrap.deployment === 'web' ? translate('设置与密钥保存在你的服务器。密钥不会出现在学习备份中。') : translate('设置只保存在这台电脑。密钥不会出现在学习备份中。')}/><div className="settings-grid"><section className="settings-card"><span className="tile-icon lavender"><BookOpen/></span><h2>{translate("从哪一课开始")}</h2><label>{translate("当前选择")}<select value={settings.currentLessonId} onChange={event => void update({ currentLessonId: Number(event.target.value), setupComplete: true }).catch(error => notice(error.message))}>{lessons.map(lesson => <option value={lesson.id} key={lesson.id}>{translate("第")}{lesson.id}{translate("课 ·")}{lesson.title}</option>)}</select></label><p className="tiny-note">{translate("选择当前课，不会把前面的课标为已掌握。")}</p>{([{ field: 'largeText', title: translate('大字模式'), description: translate('更大的文字与间距') }, { field: 'furigana', title: translate('显示日语读音'), description: translate('句子上方显示假名读音') }, { field: 'autoplay', title: translate('自动朗读 AI 回答'), description: translate('发送后自动听到日语') }] as const).map(item => <label className="toggle-row" key={item.field}><span><strong>{item.title}</strong><small>{item.description}</small></span><input type="checkbox" checked={settings[item.field]} onChange={event => void update({ [item.field]: event.target.checked }).catch(error => notice(error.message))}/></label>)}</section>
      <section className="settings-card"><span className="tile-icon lime"><MessageCircle/></span><h2>{translate("连接 DeepSeek")}</h2><p className="status-line"><span className={settings.hasApiKey ? 'status-dot ready' : 'status-dot'}/>{settings.hasApiKey ? translate('已配置密钥，实际可用性以调用结果为准') : translate('尚未配置，可以先学课程')}</p><label>{translate("API 密钥")}<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={settings.hasApiKey ? translate('填写新密钥可替换，留空保持不变') : translate('在这里填写你的 DeepSeek API 密钥')}/></label><label>{translate("模型")}<input value={model} onChange={event => setModel(event.target.value)} maxLength={100}/></label><Button onClick={save} disabled={pending}>{pending ? translate('保存中……') : translate('保存 AI 设置')}<Check size={18}/></Button><p className="tiny-note">{translate("对话会联网调用 DeepSeek，费用按你的 API 账户计算。")}</p></section>
      <VoiceSettings speech={speech} notice={notice} deployment={bootstrap.deployment}/>
      <AudioAssessmentSettings/>
      <section className="settings-card"><span className="tile-icon peach"><Mic/></span><h2>{translate("麦克风与朗读")}</h2><p className="status-line"><span className={`status-dot ${bootstrap.speech.ready ? 'ready' : ''}`}/>对话转写：{bootstrap.speech.message}</p><div className="row-actions"><Button secondary onClick={testMic}><Mic size={18}/>{translate("测试麦克风")}</Button><Button secondary data-audio-source="settings-voice-test" onClick={() => speech.say('こんにちは。ゆっくり練習しましょう。', 'ja-JP', 1, 'settings-voice-test')}><Volume2 size={18}/>{translate("试听日语")}</Button><Button secondary data-audio-source="settings-voice-test" onClick={() => speech.say('我们一次只练一句，慢慢来。', 'zh-CN', 1, 'settings-voice-test')}>{translate("试听中文")}</Button></div><AudioControls speech={speech} sourceId="settings-voice-test"/><p className="tiny-note">{bootstrap.deployment === 'web' ? '录音通过上方的百炼听音服务评分，不保存历史录音。' : '录音通过上方的百炼听音服务评分，不保存历史录音。'}</p><button className="text-button" onClick={() => void refresh().then(() => notice(translate('语音安装状态已更新。'))).catch(error => notice(error.message))}>{translate("重新检查语音状态")}<RotateCcw size={16}/></button></section>
      <section className="settings-card"><span className="tile-icon blue"><ShieldCheck/></span><h2>{translate("保管学习记录")}</h2><p className="tiny-note">导出题目、文字反馈和成绩。录音只暂存在当前页面，离开后释放，不进入备份。</p><p>{bootstrap.deployment === 'web' ? '进度、对话与复习存在你的服务器。导出一份，下载到当前设备备份。未发送的草稿只保留在当前浏览器。' : '进度、对话与复习存在本机。导出一份，留作备份。'}</p><div className="row-actions"><Button secondary onClick={downloadBackup}><Download size={18}/>{translate("导出记录")}</Button><label className="button secondary upload-button"><Upload size={18}/>{translate("选择备份")}<input aria-label={translate("选择学习备份文件")} type="file" accept="application/json,.json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { if (file.size > 16 * 1024 * 1024) throw new Error(translate('备份文件不能超过 16 MB。')); setRestoreFile({ name: file.name, backup: JSON.parse(await file.text()) }); } catch (error) { notice((error as Error).message); } event.target.value = ''; }}/></label></div>{restoreFile && <div className="restore-confirm"><p>{translate("恢复“")}{restoreFile.name}{translate("”会替换当前学习记录，保留 API 密钥。")}</p><div className="row-actions"><Button disabled={pending} onClick={async () => { setPending(true); try { await post('/restore', { backup: restoreFile.backup }); await refresh(); setRestoreFile(null); notice(translate('学习记录已恢复。')); } catch (error) { notice((error as Error).message); } finally { setPending(false); } }}>{translate("确认恢复")}</Button><Button secondary onClick={() => setRestoreFile(null)}>{translate("取消")}</Button></div></div>}</section>
    </div><details className="source-details"><summary>{translate("教材、模型与使用说明")}</summary><p>课程按《大家的日语》第二版初级Ⅰ（1–25课）和初级Ⅱ（26–50课）的主要语法目标整理。词汇、例句、听力与练习为原创辅助材料，不是原版课本或官方题库。</p><p><a href="https://plus.3anet.co.jp/mnc/contents/" target="_blank" rel="noreferrer">{translate("出版社教材说明")}</a> · <a href="https://api-docs.deepseek.com/" target="_blank" rel="noreferrer">{translate("DeepSeek 接口")}</a> · <a href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noreferrer">{translate("语音识别组件")}</a></p><p>{translate("未验证的 AI 回复不代表标准答案。遇到疑问，可与教材核对。本机朗读为合成声音。")}</p></details></>;
}

function Onboarding({ current, lessons, close, complete, notice, deployment = 'local' }: { current: number; lessons: Lesson[]; close: () => void; complete: (id: number, key: string) => Promise<void>; notice: (text: string) => void; deployment?: 'local' | 'web' }) {
  const [id, setId] = useState(current); const [key, setKey] = useState(''); const [pending, setPending] = useState(false); const [micStatus, setMicStatus] = useState('');
  useEffect(() => { const dialog = document.getElementById('welcome-dialog') as HTMLDialogElement; dialog.showModal(); const onCancel = () => close(); dialog.addEventListener('cancel', onCancel); return () => dialog.removeEventListener('cancel', onCancel); }, []);
  return <dialog id="welcome-dialog" className="welcome-dialog" aria-labelledby="welcome-title"><div className="dialog-top"><span className="tile-icon lime"><Leaf/></span><button className="icon-button" aria-label="关闭起点设置" onClick={close}><X/></button></div><p className="eyebrow">欢迎来到你的学习角落</p><h2 id="welcome-title">从你正在学的地方开始。</h2><p>前面的课可以随时回头练。</p><label>选一课<select value={id} onChange={event => setId(Number(event.target.value))}>{lessons.map(lesson => <option value={lesson.id} key={lesson.id}>{translate("第")}{lesson.id}{translate("课 ·")}{lesson.title}</option>)}</select></label><label>DeepSeek API 密钥（可以稍后设置）<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={deployment === 'web' ? '只保存在你的服务器后端' : '只保存在本机后端'}/></label><Button secondary onClick={async () => { try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); setMicStatus('麦克风可以打开。开始后可录一句日语。'); } catch { setMicStatus('麦克风未开启，可以先打字。稍后在设置里重试。'); } }}><Mic size={18}/>{translate("测试麦克风")}</Button>{micStatus && <p role="status" className="tiny-note">{micStatus}</p>}<Button disabled={pending} onClick={async () => { setPending(true); try { await complete(id, key.trim()); } catch (error) { notice((error as Error).message); } finally { setPending(false); } }}>{pending ? '正在保存' : '从这一课开始'}<ArrowRight size={18}/></Button></dialog>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
