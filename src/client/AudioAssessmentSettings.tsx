import { translate } from './i18n';
import { useEffect, useState } from 'react';
import { Ear, Check, RotateCcw } from 'lucide-react';
import type { AudioAssessmentSettings as Settings } from '../shared/audio-assessment';
import { api } from './api';
import { Button } from './ui';

export function AudioAssessmentSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    const timer = setTimeout(() => { setError(translate('读取听音设置超时，请检查网络后重试。')); controller.abort(); }, 10000);
    void api<Settings>('/speaking/audio-settings', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setSettings(value); setWorkspaceId(value.workspaceId); }
    }).catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [revision]);
  async function save() {
    if (pending) return;
    setPending(true); setMessage(''); setError('');
    const signal = AbortSignal.timeout(15000);
    try {
      const value = await api<Settings>('/speaking/audio-settings', {
        method: 'PATCH', signal, body: JSON.stringify({ workspaceId: workspaceId.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) }),
      });
      setSettings(value); setKey(''); setMessage(translate('已保存。到“自己说”录一句，检查实际反馈和用时。'));
    } catch (failure) { setError(signal.aborted ? translate('保存听音设置超时，请检查网络后重试。') : (failure as Error).message); }
    finally { setPending(false); }
  }
  return <section className="settings-card" aria-labelledby="audio-assessment-title">
    <span className="tile-icon lavender"><Ear/></span><h2 id="audio-assessment-title">{translate("AI 听录音")}</h2>
    <p>{translate("录音结束后，AI 直接听音频，自动反馈日语语法和发音。")}</p>
    <p className="status-line"><span className={`status-dot ${settings?.hasApiKey ? 'ready' : ''}`}/>{!settings ? translate('正在读取配置') : settings.hasApiKey ? translate('百炼密钥已保存，效果与用时以录音测试为准') : translate('尚未配置百炼密钥')}</p>
    <label htmlFor="audio-assessment-key">{translate("阿里云百炼 API 密钥（北京地域）")}<input id="audio-assessment-key" type="password" autoComplete="off" spellCheck={false} value={key} maxLength={512} onChange={event => setKey(event.target.value)} placeholder={settings?.hasApiKey ? translate('留空保持原密钥') : translate('填写百炼 API 密钥')}/>
    </label>
    <details><summary>{translate("业务空间设置（可选）")}</summary><label htmlFor="audio-assessment-workspace">{translate("业务空间 ID")}<input id="audio-assessment-workspace" value={workspaceId} maxLength={100} onChange={event => setWorkspaceId(event.target.value)} placeholder={translate("留空使用北京兼容地址")} autoComplete="off" spellCheck={false}/>
    </label><p className="tiny-note">{translate("如控制台提供业务空间专属地址，填写其中的业务空间 ID。")}</p></details>
    <Button disabled={pending || !settings || (!settings.hasApiKey && !key.trim())} onClick={() => void save()}><Check size={18}/>{pending ? translate('正在保存……') : translate('保存听音设置')}</Button>
    {message && <p role="status" className="tiny-note">{message}</p>}
    {error && <div role="alert"><p>{error}</p>{!settings && <Button secondary onClick={() => setRevision(value => value + 1)}><RotateCcw size={16}/>{translate("重新读取配置")}</Button>}</div>}
    <p className="tiny-note">{translate("使用 Qwen3.8-Omni-Flash。每次结束录音会将音频发送到百炼并产生 API 用量；密钥仅保存在后端。DeepSeek 继续用于打字练习和对话。")}</p>
    <p className="tiny-note">{translate("提供 AI 听音建议，不代表专业发音考试成绩；实际速度受网络与服务负载影响。")}</p>
    <p><a href="https://help.aliyun.com/zh/model-studio/get-api-key" target="_blank" rel="noreferrer">{translate("获取百炼密钥")}</a> · <a href="https://help.aliyun.com/zh/model-studio/qwen-omni" target="_blank" rel="noreferrer">{translate("音频服务说明")}</a></p>
  </section>;
}
