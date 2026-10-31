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
}`

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'

export function installIndexInjection(webServer, log) {
  const dispose = webServer.tapIndex((source) => {
    try {
      let output = source
      output = output.replace(/<meta[^>]+name=["']viewport["'][^>]*>/i, `<meta name="viewport" content="${VIEWPORT}">`)
      if (!/name=["']viewport["']/i.test(output)) {
        output = output.replace(/<head[^>]*>/i, (match) => `${match}\n<meta name="viewport" content="${VIEWPORT}">`)
      }
      const injection = `<style data-dsh-mobile-bridge="1">${STYLE}</style>` +
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
