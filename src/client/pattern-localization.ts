import { getPreferences } from './preferences';

// Translate grammatical placeholders while keeping Japanese particles, conjugations
// and example forms intact. Translating an entire formula can destroy its lesson.
const labels: Record<string,[string,string]> = {
  '身份':['身分','identity'],'组织':['組織','organization'],'物品':['物','item'],'持有人':['持ち主','owner'],'内容':['内容','content'],
  '地点':['場所','place'],'場所':['場所','place'],'所属':['所属','affiliation'],'商品':['商品','product'],'时刻':['時刻','time'],
  '动作':['動作','action'],'开始':['開始','start'],'结束':['終了','end'],'目的地':['目的地','destination'],'交通工具':['交通手段','transport'],
  '移动':['移動','movement'],'日期':['日付','date'],'对象':['対象','object'],'工具':['道具','tool'],'语言':['言語','language'],
  '形容词':['形容詞','adjective'],'名词':['名詞','noun'],'原因':['原因','cause'],'结果':['結果','result'],'位置':['位置','location'],
  '数量':['数量','quantity'],'量词':['助数詞','counter'],'时间范围':['期間','time span'],'次数':['回数','frequency'],'范围':['範囲','range'],
  '最后':['最後の','final '],'先做的事':['先にすること','first action'],'后做的事':['後ですること','next action'],
  '辞书形':['辞書形','dictionary form'],'准备':['準備の','preparatory '],'普通形':['普通形','plain form'],
  '去だ':['だを取る','remove だ'],'做的事':['すること','action'],'描述短句':['修飾節','descriptive clause'],
  '不同时间关系':['時間関係の違い','different time relationships'],'条件':['条件','condition'],'自然':['自然な','natural '],
  '对方':['相手','other person'],'我':['私','I'],'普通过去形':['普通形の過去','plain past form'],'计划':['計画','plan'],
  '判断':['判断','judgment'],'下一步':['次の行動','next step'],'仍然做':['それでもする','still do'],
  '疑问词句':['疑問詞節','question-word clause'],'疑问词':['疑問詞','question word'],'可能形':['可能形','potential form'],
  '景物':['景色','scene'],'声音':['音','sound'],'否定形':['否定形','negative form'],'设施':['施設','facility'],
  '对比用':['対比の','contrastive '],'追加用':['追加の','additional '],'去ます':['ますを取る','remove ます'],
  '主要':['主な','main '],'频率':['頻度','frequency'],'理由':['理由','reason'],'结论':['結論','conclusion'],
  '自动词':['自動詞','intransitive verb'],'他动词':['他動詞','transitive verb'],'意外的':['意外な','unexpected '],
  '动词':['動詞','verb'],'意向形':['意向形','volitional form'],'命令形':['命令形','imperative form'],
  '表达':['表現','expression'],'后续':['その後の','subsequent '],'条件形':['条件形','conditional form'],
  '话题':['話題','topic'],'建议':['助言','suggestion'],'目标':['目標','goal'],'努力':['努力','effort'],
  '受身形':['受身形','passive form'],'事物':['物事','thing'],'评价':['評価','evaluation'],'事实':['事実','fact'],
  '强调的信息':['強調する情報','emphasized information'],'感受或结果':['気持ち・結果','feeling or result'],
  '事件':['出来事','event'],'请求':['依頼','request'],'主句':['主節','main clause'],'行动':['行動','action'],
  '用途':['用途','purpose'],'时间':['時間','time'],'费用':['費用','cost'],'词干':['語幹','stem'],
  '选项':['選択肢','option'],'处理':['対応','response'],'预期的依据':['予想の根拠','basis for expectation'],
  '相反结果':['逆の結果','contrary result'],'依据':['根拠','basis'],'消息来源':['情報源','source'],
  '观察到的迹象':['観察した様子','observed signs'],'使役形':['使役形','causative form'],'使役':['使役','causative '],
  '特别尊敬':['特別な尊敬','special honorific '],'己方':['自分側の','own '],'特别谦让':['特別な謙譲','special humble '],
  '介绍':['紹介','introduction'],'状态':['状態','state'],'丁重':['丁重な','polite '],'人':['人','person']
};
const tokens=new RegExp(Object.keys(labels).sort((a,b)=>b.length-a.length).join('|'),'g');
export function localizePattern(value:string){const locale=getPreferences().locale;if(locale==='zh-CN')return value;return value.replace(tokens,token=>labels[token][locale==='ja-JP'?0:1]);}
