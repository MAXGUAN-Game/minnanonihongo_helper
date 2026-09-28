import { useId, type ReactNode } from 'react';
import { Volume2, ArrowRight, Leaf, BookOpen, Headphones, MessageCircle } from 'lucide-react';
import type { Example } from '../shared/types';
import type { Speech } from './speech';
import { AudioControls } from './AudioControls';

export function Button({ children, secondary = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button type="button" {...props} className={`button ${secondary ? 'secondary' : ''} ${props.className || ''}`}>{children}</button>;
}
export function Heading({ eyebrow, title, description, children }: { eyebrow: string; title: ReactNode; description?: string; children?: ReactNode }) {
  return <header className="page-heading"><div><p className="eyebrow"><span />{eyebrow}</p><h1 tabIndex={-1}>{title}</h1>{description && <p className="subtitle">{description}</p>}</div>{children}</header>;
}
export function Sentence({ example, speech, furigana, translation = true }: { example: Example; speech: Speech; furigana: boolean; translation?: boolean }) {
  const sourceId = useId();
  return <div className="sentence"><div className="sentence-text">{furigana && <p className="reading" lang="ja">{example.kana}</p>}<p className="japanese" lang="ja">{example.jp}</p>{translation && <p className="meaning">{example.zh}</p>}</div><button className="icon-button" aria-label={`朗读：${example.jp}`} onClick={() => speech.say(example.jp, 'ja-JP', 1, sourceId)}><Volume2 size={22} /></button><AudioControls speech={speech} sourceId={sourceId}/></div>;
}
export function ArtPath() {
  return <div className="art-path" aria-label="从学过，到听懂，再到说出来"><div className="art-node lavender"><BookOpen aria-hidden="true" /><b>学过</b></div><ArrowRight className="art-arrow" aria-hidden="true"/><div className="art-node peach"><Headphones aria-hidden="true"/><b>听懂</b></div><ArrowRight className="art-arrow" aria-hidden="true"/><div className="art-node lime"><MessageCircle aria-hidden="true"/><b>说出来</b></div><span className="art-caption"><Leaf size={16}/>每天连接一小步</span></div>;
}
export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) { return <div className="empty-card"><span className="empty-icon"><Leaf/></span><h2>{title}</h2><p>{text}</p>{children}</div>; }
