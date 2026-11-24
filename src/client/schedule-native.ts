import source from '../../weekly-plan.html?raw';
import theme from './schedule-theme.css?raw';
import layout from './schedule-native.css?raw';

/** Reuse the standalone planner's data/editor engine inside the application DOM.
 * Styles and selectors are scoped; vertical scrolling belongs to the page. */
export function mountSchedule(host: HTMLElement, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  parsed.querySelector('label[for="event-day"]')!.textContent = '星期';
  parsed.querySelector('#copy-details summary')!.textContent = '同时复制到其他天';
  const footer = parsed.querySelector('.page-foot p')!;
  footer.innerHTML = footer.innerHTML.replace('所有周共用同一份计划，日期仅供预览。', '计划每周重复，按星期安排。');
  if (storage !== localStorage) footer.innerHTML = footer.innerHTML.replace('日程保存在当前浏览器，建议定期导出备份。', '日程保存在服务器，所有设备共用；建议定期导出备份。');
  let engine = parsed.querySelector('script')!.textContent!;
  const styles = [...parsed.querySelectorAll('style')].map(style => style.textContent).join('\n');
  parsed.querySelectorAll('script, style').forEach(node => node.remove());
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const scopedStyles = `${styles}\n${theme}\n${layout}`
    .replaceAll(':root', ':host').replace(/\bbody\b/g, '.schedule-document')
    .replace(/\.large-text /g, ':host(.large-text) ')
    .replace(/(font-size|line-height):\s*([\d.]+)px/g, (_match, property, value) => `${property}:${Number(value) * 1.5}px`);
  root.innerHTML = `<style>${scopedStyles}</style><div class="schedule-document">${parsed.body.innerHTML}</div>`;
  const body = root.querySelector<HTMLElement>('.schedule-document')!;
  const board = root.querySelector<HTMLElement>('#board')!;
  const scroller = root.querySelector<HTMLElement>('#board-scroll')!;
  root.querySelector('.planner')!.after(root.querySelector('#stats')!);
  root.querySelector('.planner-head')!.prepend(root.querySelector('.top-actions')!);

  const controller = new AbortController();
  let measuredWidth = 0;
  let measuredHeader: HTMLElement | null = null;
  const refreshPageLayout = () => {
    const header = root.querySelector<HTMLElement>('.day-head');
    if (header && (header !== measuredHeader || board.clientWidth !== measuredWidth)) {
      // Font enlargement can wrap weekday metadata. All columns, including the
      // time axis, share the tallest natural header instead of a fixed guess.
      host.style.removeProperty('--schedule-header-height');
      const height = Math.max(112, ...Array.from(root.querySelectorAll<HTMLElement>('.day-head'), node => node.offsetHeight));
      host.style.setProperty('--schedule-header-height', `${height}px`);
      measuredHeader = header;
      measuredWidth = board.clientWidth;
    }
    const bounds = board.getBoundingClientRect();
    const height = header?.offsetHeight ?? 112;
    host.style.setProperty('--schedule-header-shift', `${Math.max(0, Math.min(-bounds.top, bounds.height - height))}px`);
  };
  const timelineViewport = () => {
    refreshPageLayout();
    return {
      top: Math.max(0, root.querySelector('.day-head')!.getBoundingClientRect().bottom),
      bottom: Math.min(scroller.getBoundingClientRect().bottom, window.innerHeight - (window.innerWidth <= 600 ? 90 : 8)),
    };
  };
  const listen = (target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
    target.addEventListener(type, listener, { ...(typeof options === 'boolean' ? { capture: options } : options), signal: controller.signal });
  };
  // Window listeners receive the actual control as their target across the
  // shadow boundary, so typing Ctrl+Z in an editor keeps native undo behavior.
  const actualEvent = (event: Event) => new Proxy(event, {
    get(target, property) {
      if (property === 'target') return target.composedPath()[0] ?? target.target;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const scopedDocument = new Proxy(document, {
    get(target, property) {
      if (property === 'body') return body;
      if (property === 'activeElement') return root.activeElement;
      if (property === 'getElementById') return (id: string) => root.querySelector(`#${CSS.escape(id)}`);
      if (property === 'querySelector') return root.querySelector.bind(root);
      if (property === 'querySelectorAll') return root.querySelectorAll.bind(root);
      if (property === 'addEventListener') return (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
        listen(type === 'scroll' || type === 'visibilitychange' ? document : root, type, listener, options);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const scopedWindow = new Proxy(window, {
    get(target, property) {
      if (property === 'innerHeight') return target.innerHeight - (target.innerWidth <= 600 ? 90 : 0);
      if (property === 'addEventListener') return (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
        listen(window, type, event => listener(actualEvent(event)), options);
      };
      if (property === 'scrollBy') return (x: number, y: number) => { window.scrollBy(x, y); refreshPageLayout(); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  function replace(before: string, after: string) {
    if (!engine.includes(before)) throw new Error(`Planner integration needs updating: ${before.slice(0, 65)}`);
    engine = engine.replaceAll(before, after);
  }
  // This is a recurring weekday template. Keep the historical activeWeek field
  // for backup compatibility, but never present it as a dated calendar.
  replace("+(key===dateKey(new Date())?' today':'')", "");
  replace('`${DAY_NAMES[day]} ${d.getMonth()+1}月${d.getDate()}日`', 'DAY_NAMES[day]');
  replace('`${name} · ${d.getMonth()+1}月${d.getDate()}日`', 'name');
  replace('`${DAY_NAMES[contextTarget.day]} · ${date.getMonth()+1}月${date.getDate()}日 ${timeText(start)}`', '`${DAY_NAMES[contextTarget.day]} · ${timeText(start)}`');
  replace('state.activeWeek===monday(new Date())?(new Date().getDay()+6)%7:0', '(new Date().getDay()+6)%7');
  // Keep original time-to-pixel coordinates and pointer capture. Only replace
  // the vertical scroll owner and measure the actual sticky header boundary.
  replace('bounds.top+112', 'timelineViewport().top');
  replace('rect.top+112', 'timelineViewport().top');
  replace('scroller.scrollTop+=speed(boxGesture.y,Math.max(timelineViewport().top,0),Math.min(rect.bottom,innerHeight));',
    'window.scrollBy(0,speed(boxGesture.y,timelineViewport().top,timelineViewport().bottom));');
  replace('scroller.scrollTop+=deltaY;', 'window.scrollBy(0,deltaY);');
  replace('oldTop=scroller.scrollTop;', 'oldTop=window.scrollY;');
  replace('deltaY-(scroller.scrollTop-oldTop)', 'deltaY-(window.scrollY-oldTop)');
  replace('beforeY=scroller.scrollTop;', 'beforeY=window.scrollY;');
  replace('scroller.scrollLeft+=dx;scroller.scrollTop+=dy;', 'scroller.scrollLeft+=dx;window.scrollBy(0,dy);');
  replace('scroller.scrollTop!==beforeY', 'window.scrollY!==beforeY');
  replace('scroller.scrollTop=timelineInitialized&&!foldChanged?oldTop:folded?0:8*60*MINUTE_HEIGHT;scroller.scrollLeft=oldLeft;timelineInitialized=true;lastFolded=folded;',
    'scroller.scrollLeft=oldLeft;timelineInitialized=true;lastFolded=folded;refreshPageLayout();');
  replace('function closeContextMenu(restoreFocus=false) {',
    'let menuScrollY=0,menuScrollX=0,menuScrollLeft=0;\n      function closeContextMenu(restoreFocus=false) {');
  replace("const menu=$('context-menu');menu.hidden=false;",
    "const menu=$('context-menu');menu.hidden=false;menuScrollY=window.scrollY;menuScrollX=window.scrollX;menuScrollLeft=$('board-scroll').scrollLeft;");
  // A queued scroll event from revealing a card must not immediately dismiss
  // the menu opened on that card. Close only when the position actually changes.
  replace("document.addEventListener('scroll',()=>closeContextMenu(),{capture:true,passive:true});",
    "document.addEventListener('scroll',()=>{if(menuScrollY!==window.scrollY||menuScrollX!==window.scrollX||menuScrollLeft!==$('board-scroll').scrollLeft)closeContextMenu();},{capture:true,passive:true});");
  // Use the current viewport after resize, including the mobile navigation inset.
  engine = engine.replace(/(?<![\w.])innerHeight\b/g, 'window.innerHeight');
  // Shadow DOM clears an event's target after dispatch; keep the file input
  // itself across the asynchronous file.text() call.
  replace('const file=event.target.files?.[0];if(!file)return;', 'const input=event.currentTarget,file=input.files?.[0];if(!file)return;');
  replace("finally { event.target.value=''; }", "finally { input.value=''; }");
  const statsStart = engine.indexOf('      function renderStats() {');
  const statsEnd = engine.indexOf('      function render() {', statsStart);
  if (statsStart < 0 || statsEnd < 0) throw new Error('Planner statistics integration needs updating.');
  engine = engine.slice(0, statsStart) + `
      function renderStats() {
        const container=$('stats');container.replaceChildren();
        const categories=Object.keys(CATEGORIES).filter(key=>key!=='routine'&&(!CATEGORIES[key].retired||minutesFor(key)>0));
        const total=categories.reduce((sum,key)=>sum+minutesFor(key),0);
        const heading=element('div','summary-heading');
        heading.append(element('h2','','每周时间分配'),element('strong','',duration(total)));
        const track=element('div','summary-track');track.setAttribute('role','img');
        track.setAttribute('aria-label',categories.map(key=>CATEGORIES[key].name+' '+duration(minutesFor(key))).join('，'));
        const legend=element('div','summary-legend');
        for(const key of categories){
          const config=CATEGORIES[key],minutes=minutesFor(key);
          if(minutes){const segment=element('span','summary-segment');segment.style.width=(minutes/total*100)+'%';segment.style.background=config.color;segment.title=config.name+' · '+duration(minutes);segment.dataset.category=key;track.append(segment);}
          const item=element('article','summary-item');item.dataset.cat=key;
          const dot=element('span','summary-dot');dot.style.background=config.color;dot.setAttribute('aria-hidden','true');
          item.append(dot,element('span','',config.name),element('strong','',duration(minutes)));legend.append(item);
        }
        container.append(heading,track,legend);
      }
` + engine.slice(statsEnd);
  replace('initCategories();load();render();if(!storageBlocked)persist();',
    'initCategories();load();render();if(!storageBlocked)persist();return () => {cancelGestures();clearTimeout(toastTimer);};');
  if (storage !== localStorage) replace('已自动保存到此浏览器', '正在保存到服务器…');
  const disposeEngine = new Function('document', 'window', 'refreshPageLayout', 'timelineViewport', 'localStorage', `return ${engine.trim()}`)(scopedDocument, scopedWindow, refreshPageLayout, timelineViewport, storage) as () => void;
  listen(window, 'scroll', refreshPageLayout, { passive: true });
  listen(window, 'resize', refreshPageLayout, { passive: true });
  const resize = new ResizeObserver(refreshPageLayout);
  resize.observe(board);
  refreshPageLayout();
  return () => {
    disposeEngine();
    controller.abort();
    resize.disconnect();
    root.replaceChildren();
  };
}
