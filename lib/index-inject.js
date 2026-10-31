/**
 * index.html 注入：移动端 polyfill、viewport 修正、安全区与窄屏补丁。
 *
 * 走 `webServer.tapIndex`，因此只作用于 Web 入口（浏览器），Electron 的内嵌页
 * 走 file:// 或桌面窗口不受影响。注入内容刻意保守：不替换布局、不改路由，
 * 只补浏览器能力与安全区。
 */
const POLYFILL = `(function(){
if(typeof AbortSignal==='undefined')return;
if(typeof AbortSignal.any!=='function'){
  AbortSignal.any=function(signals){
    var controller=new AbortController();
    for(var i=0;i<signals.length;i++){
      var signal=signals[i];
      if(!signal)continue;
      if(signal.aborted){controller.abort(signal.reason);return controller.signal;}
      (function(s){
        s.addEventListener('abort',function(){controller.abort(s.reason);},{once:true});
      })(signal);
    }
    return controller.signal;
  };
}
if(typeof AbortSignal.timeout!=='function'){
  AbortSignal.timeout=function(ms){
    var controller=new AbortController();
    setTimeout(function(){
      try{controller.abort(new DOMException('TimeoutError','TimeoutError'));}
      catch(error){controller.abort();}
    },ms);
    return controller.signal;
  };
}
})();`

const STYLE = `
html{-webkit-text-size-adjust:100%}
body{padding-bottom:env(safe-area-inset-bottom)}
@media (max-width:900px){
  body{min-height:100vh;min-height:100dvh}
  input,textarea,select{font-size:16px}
  button{min-height:40px}
}
/* 触屏常显：宿主把部分控件藏在 :hover 后（CSS-module 前缀跨构建稳定，hash 部分用
   [class*=] 匹配，改名时规则自然失效，不会误伤）。只处理真正无法触达的交互控件。 */
@media (hover: none) and (pointer: coarse){
  [class*="_copySlot_"]{opacity:1 !important;pointer-events:auto !important}
  [class*="_tabClose_"]{opacity:1 !important;pointer-events:auto !important}
}`

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'

/**
 * PWA 标签：manifest/图标走插件同源路由（经 edge 分发，无需宿主额外配置）。
 * Chrome 108+/iOS 对「安装到主屏」不再强制要求 Service Worker；宿主的 / 路径
 * 归宿主管，插件无法在根上挂 sw.js，所以不做离线缓存，只做可安装 + 全屏。
 */
const PWA_TAGS =
  '<meta name="theme-color" content="#0f172a">' +
  '<meta name="mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
  '<meta name="apple-mobile-web-app-title" content="DSH">' +
  '<link rel="manifest" href="/plugins/dsh-mobile-bridge/manifest.webmanifest">' +
  '<link rel="apple-touch-icon" href="/plugins/dsh-mobile-bridge/apple-touch-icon.png">'

/**
 * 索引缓存策略：插件升级后如果浏览器继续用旧 index，会表现为「半身缺失 / 界面残缺」。
 * 这里补一组 no-cache meta，尽量让 HTML 每次都回源。
 */
const CACHE_META = '<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">' +
  '<meta http-equiv="Pragma" content="no-cache">' +
  '<meta http-equiv="Expires" content="0">'

export function installIndexInjection(webServer, log) {
  const dispose = webServer.tapIndex((source) => {
    try {
      let output = source
      output = output.replace(/<meta[^>]+name=["']viewport["'][^>]*>/i, `<meta name="viewport" content="${VIEWPORT}">`)
      if (!/name=["']viewport["']/i.test(output)) {
        output = output.replace(/<head[^>]*>/i, (match) => `${match}\n<meta name="viewport" content="${VIEWPORT}">`)
      }
      const injection = `<style data-dsh-mobile-bridge="1">${STYLE}</style>` +
        `${CACHE_META}` +
        `${PWA_TAGS}` +
        `<script data-dsh-mobile-bridge="1">${POLYFILL}</script>`
      if (/<\/head>/i.test(output)) return output.replace(/<\/head>/i, `${injection}\n</head>`)
      return `${injection}\n${output}`
    } catch (error) {
      log('index injection failed:', error?.message ?? error)
      return source
    }
  })
  return dispose
}
