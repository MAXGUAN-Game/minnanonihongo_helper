import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Headphones, MessageCircle, RotateCcw, Volume2 } from 'lucide-react';
import type { VoiceCacheStats, VoiceSettings as VoiceSettingsData, VoiceSettingsPatch } from '../shared/voice';
import { api } from './api';
import type { Speech } from './speech';
import { Button } from './ui';
import { AudioControls } from './AudioControls';

const sentence = 'こんにちは。駅はどこですか。もう一度お願いします。';
const dialogue = ['こんにちは。駅はどこですか。', '駅は、この道をまっすぐ行ってください。'];
const voiceOptions = [
  { id: 'Japanese_KindLady', label: '温柔女声' },
  { id: 'Japanese_CalmLady', label: '沉静女声' },
  { id: 'Japanese_IntellectualSenior', label: '知性前辈' },
  { id: 'Japanese_GentleButler', label: '温和管家' },
] as const;

function cacheSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VoiceSettings({ speech, notice, deployment = 'local' }: { speech: Speech; notice: (text: string) => void; deployment?: 'local' | 'web' }) {
  const [settings, setSettings] = useState<VoiceSettingsData | null>(null);
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<'save' | 'sentence' | 'dialogue' | 'clear' | null>(null);
  const [cache, setCache] = useState<VoiceCacheStats | null>(null);
  const [cacheError, setCacheError] = useState('');
  const [cacheLoading, setCacheLoading] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const operation = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError('');
    try {
      const value = await api<VoiceSettingsData>('/voice/settings', { signal });
      if (!signal?.aborted && alive.current) setSettings(value);
    } catch (error) {
      if (!signal?.aborted && alive.current) setLoadError((error as Error).message);
    } finally {
      if (!signal?.aborted && alive.current) setLoading(false);
    }
  }, []);

  const loadCache = useCallback(async () => {
    setCacheLoading(true);
    setCacheError('');
    try {
      const value = await api<VoiceCacheStats>('/voice/cache');
      if (alive.current) setCache(value);
    } catch (error) {
      if (alive.current) setCacheError((error as Error).message);
    } finally {
      if (alive.current) setCacheLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const request = new AbortController();
    void load(request.signal);
    return () => { alive.current = false; request.abort(); };
  }, [load]);

  useEffect(() => {
    if (cacheOpen && !speech.speaking && !pending) void loadCache();
  }, [cacheOpen, speech.speaking, pending, loadCache]);

  function change(changes: Partial<VoiceSettingsData>) {
    setSettings(previous => previous ? { ...previous, ...changes } : previous);
    setMessage('');
  }

  async function save(preview?: 'sentence' | 'dialogue') {
    if (!settings || operation.current) return;
    if (settings.provider === 'minimax' && !key.trim() && !settings.hasApiKey) {
      setMessage('请先填写 MiniMax API 密钥。');
      document.getElementById('minimax-speech-key')?.focus();
      return;
    }
    operation.current = true;
    setPending(preview || 'save');
    setMessage('');
    speech.stop();
    try {
      const patch: VoiceSettingsPatch = {
        provider: settings.provider, model: settings.model, voice: settings.voice, secondaryVoice: settings.secondaryVoice,
        alternateSpeakers: settings.alternateSpeakers, speed: settings.speed,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
      };
      const saved = await api<VoiceSettingsData>('/voice/settings', { method: 'PATCH', body: JSON.stringify(patch) });
      if (!alive.current) return;
      setSettings(saved);
      setKey('');
      window.dispatchEvent(new Event('voice-settings-changed'));
      setMessage('声音设置已保存。');
      if (preview) await speech.say(preview === 'dialogue' ? dialogue : sentence, 'ja-JP', 1, 'voice-settings-preview');
      else notice(deployment === 'web' ? '声音设置已保存在你的服务器。' : '声音设置已保存在本机。');
    } catch (error) {
      if (alive.current) setMessage((error as Error).message);
    } finally {
      operation.current = false;
      if (alive.current) setPending(null);
    }
  }

  async function clearCache() {
    if (operation.current) return;
    operation.current = true;
    setPending('clear');
    setCacheError('');
    try {
      await api('/voice/cache', { method: 'DELETE' });
      if (!alive.current) return;
      setConfirmClear(false);
      await loadCache();
      setMessage('缓存已清理，声音设置仍然保留。');
    } catch (error) {
      if (alive.current) setCacheError((error as Error).message);
    } finally {
      operation.current = false;
      if (alive.current) setPending(null);
    }
  }

  return <section className="settings-card voice-settings" aria-labelledby="voice-settings-title">
    <span className="tile-icon blue"><Headphones aria-hidden="true"/></span>
    <h2 id="voice-settings-title">更自然的日语声音</h2>
    {loading ? <p role="status">正在读取声音设置……</p> : loadError ? <>
      <p role="alert">{loadError}</p>
      <Button secondary onClick={() => void load()}><RotateCcw size={18} aria-hidden="true"/>重新读取</Button>
    </> : settings && <>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset className="voice-fields" disabled={Boolean(pending)}>
          <legend>日语朗读方式</legend>
          <div className="voice-choice-grid" role="group" aria-label="日语朗读方式">
            <Button secondary aria-pressed={settings.provider === 'system'} onClick={() => change({ provider: 'system' })}>本机声音 · 离线</Button>
            <Button secondary aria-pressed={settings.provider === 'minimax'} onClick={() => change({ provider: 'minimax' })}>云端 AI 声音 · MiniMax</Button>
          </div>
          {settings.provider === 'minimax' && <div className="voice-cloud-options">
            <p className="status-line"><span aria-hidden="true" className={`status-dot ${settings.hasApiKey ? 'ready' : ''}`}/>{settings.hasApiKey ? 'MiniMax 密钥已配置 · 试听可确认是否可用' : 'MiniMax 密钥未配置'}</p>
            <div className="voice-form-grid">
              <label htmlFor="minimax-speech-key">MiniMax API 密钥
                <input id="minimax-speech-key" type="password" autoComplete="off" spellCheck={false} value={key} maxLength={512} onChange={event => { setKey(event.target.value); setMessage(''); }} aria-describedby="voice-key-help" placeholder={settings.hasApiKey ? '留空保持原密钥' : '填写 MiniMax API 密钥'}/>
                <span id="voice-key-help" className="tiny-note">{deployment === 'web' ? '单独的语音密钥，只保存在你的服务器后端。' : '单独的语音密钥，只保存在本机后端。'}</span>
              </label>
              <label htmlFor="minimax-speech-model">声音质量
                <select id="minimax-speech-model" value={settings.model} onChange={event => change({ model: event.target.value as VoiceSettingsData['model'] })}>
                  <option value="speech-2.8-hd">细腻 · Speech 2.8 HD</option>
                  <option value="speech-2.8-turbo">快捷 · Speech 2.8 Turbo</option>
                </select>
              </label>
              <label htmlFor="minimax-speech-voice">日语声音
                <select id="minimax-speech-voice" value={settings.voice} onChange={event => change({ voice: event.target.value as VoiceSettingsData['voice'] })}>
                  {voiceOptions.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
                </select>
              </label>
              <label htmlFor="minimax-secondary-voice">对话中第二个人的声音
                <select id="minimax-secondary-voice" value={settings.secondaryVoice} disabled={!settings.alternateSpeakers} onChange={event => change({ secondaryVoice: event.target.value as VoiceSettingsData['voice'] })}>
                  {voiceOptions.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
                </select>
              </label>
            </div>
            <label className="toggle-row voice-alternate"><span><strong>对话使用两种声音</strong><small>短对话的两个人轮流朗读</small></span><input type="checkbox" checked={settings.alternateSpeakers} onChange={event => change({ alternateSpeakers: event.target.checked })}/></label>
          </div>}
          <fieldset className="voice-speed">
            <legend>日语语速</legend>
            <div className="voice-speed-options" role="group" aria-label="日语语速">
              {([{ value: .8, label: '慢一点 · 0.8×' }, { value: 1, label: '自然 · 1×' }, { value: 1.2, label: '快一点 · 1.2×' }] as const).map(speed => <Button key={speed.value} secondary aria-pressed={settings.speed === speed.value} onClick={() => change({ speed: speed.value })}>{speed.label}</Button>)}
            </div>
          </fieldset>
          {settings.provider === 'minimax' && <p className="voice-disclosure">AI 合成声音。日语文字会发送给 MiniMax，需联网，按你的语音服务账户计费。</p>}
          <div className="row-actions voice-actions">
            <Button type="submit"><Check size={18} aria-hidden="true"/>{pending === 'save' ? '保存中……' : '保存声音设置'}</Button>
            <Button secondary data-audio-source="voice-settings-preview" onClick={() => void save('sentence')}><Volume2 size={18} aria-hidden="true"/>{pending === 'sentence' ? '准备试听……' : '保存并试听'}</Button>
            <Button secondary data-audio-source="voice-settings-preview" onClick={() => void save('dialogue')}><MessageCircle size={18} aria-hidden="true"/>{pending === 'dialogue' ? '准备对话……' : '试听短对话'}</Button>
          </div>
        </fieldset>
      </form>
      <AudioControls speech={speech} sourceId="voice-settings-preview"/>
      <p className="voice-result" role="status" aria-live="polite">{message}</p>
      <p className="tiny-note">试听会先保存当前选择。中文讲解仍用本机声音；云端失败时会提示，并尝试本机朗读。</p>
      {settings.provider === 'minimax' && <details className="voice-details">
        <summary>没有 MiniMax 密钥？查看 3 步开通方法</summary>
        <ol>
          <li>登录 <a href="https://platform.minimax.cn/" target="_blank" rel="noreferrer">MiniMax 开放平台</a>，在控制台查看语音服务额度；Token Plan 用户查看<a href="https://platform.minimax.cn/subscribe/token-plan" target="_blank" rel="noreferrer">套餐用量与积分</a>。</li>
          <li>在平台的 API 密钥管理中创建密钥，确认账户支持语音合成。</li>
          <li>填到本页，保存并试听。密钥不用发到聊天里。</li>
        </ol>
        <p>已保存密钥不代表接口可用。提示额度用尽时，请先到控制台查看额度恢复时间或可用积分。</p>
        <p>普通账户余额与 Token Plan 订阅分开使用。如果充值的是普通账户余额，请使用普通 API Key；订阅密钥需要有效的 Token Plan 额度。</p>
        <p><a href="https://platform.minimax.cn/docs/api-reference/speech-t2a-http" target="_blank" rel="noreferrer">官方语音说明</a> · <a href="https://platform.minimax.cn/docs/faq/system-voice-id" target="_blank" rel="noreferrer">日语音色</a> · <a href="https://platform.minimax.cn/subscribe/token-plan" target="_blank" rel="noreferrer">套餐与额度</a></p>
      </details>}
      <details className="voice-details" onToggle={event => setCacheOpen(event.currentTarget.open)}>
        <summary>管理已生成的声音</summary>
        <p>{deployment === 'web' ? '相同文字、音色、质量和语速会复用服务器缓存，减少联网请求。' : '相同文字、音色、质量和语速会复用本机缓存，减少联网请求。'}</p>
        <p aria-live="polite">{cacheLoading ? '正在读取缓存……' : cache ? `已缓存 ${cache.clips} 段 · ${cacheSize(cache.bytes)}` : '尚未读取缓存。'}</p>
        {cacheError && <p role="alert">{cacheError}</p>}
        {confirmClear ? <div className="restore-confirm" role="group" aria-label="确认清理声音缓存">
          <p>清理所有声音缓存？再次朗读时需要重新生成，云端可能计费。</p>
          <div className="row-actions"><Button disabled={Boolean(pending)} onClick={() => void clearCache()}>{pending === 'clear' ? '清理中……' : '确认清理'}</Button><Button secondary disabled={Boolean(pending)} onClick={() => setConfirmClear(false)}>取消</Button></div>
        </div> : <div className="row-actions">
          <Button secondary disabled={cacheLoading || Boolean(pending)} onClick={() => void loadCache()}><RotateCcw size={17} aria-hidden="true"/>刷新缓存</Button>
          <Button secondary disabled={cacheLoading || Boolean(pending) || !cache?.clips} onClick={() => setConfirmClear(true)}>清理声音缓存</Button>
        </div>}
      </details>
    </>}
  </section>;
}
