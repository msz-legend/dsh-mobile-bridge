/** 契约：client.js 必须包含宿主提问卡片的窄屏适配覆盖规则，以及 rail 空白区展开提示。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
assert.match(client, /function installQuestionFullscreen/)
assert.match(client, /html\[data-dmb-narrow="1"\] \[data-question-key\]\{/)
assert.match(client, /position:fixed!important;inset:0!important/)
assert.match(client, /\[data-question-key\] > section > \[data-question-scroll\]\{[\s\S]*?overflow-y:auto!important/)
assert.match(client, /\[data-question-key\] \[data-option-description\][\s\S]*?animation:none!important/)
assert.match(client, /\.dmb-question-back\{/)
assert.match(client, /data-dmb-question/)
assert.match(client, /\[data-dmb-question-minimized="1"\]\{/)
assert.match(client, /root\.setAttribute\(\s*'data-dmb-question-minimized'/)
assert.match(client, /cardMinimized/)
assert.match(client, /\.dmb-rail-hint\{position:fixed/)
assert.match(client, /function installRailOpenShortcut/)
// DMB-020：窄屏模型按钮只保留通用图标，不显示模型短名/推理等级/箭头。
assert.match(client, /button\[aria-label\*="选择模型"\] \[class\*="_triggerLabel"\]/)
assert.match(client, /button\[aria-label\*="选择模型"\] \[class\*="_triggerEffort"\]/)
assert.match(client, /button\[aria-label\*="选择模型"\] > \[class\*="_triggerIcon"\]/)
assert.match(client, /button\[aria-label\*="选择模型"\] \[class\*="_chevron"\]/)
assert.match(client, /\[class\*="_chevron"\]\{display:none !important\}/)
console.log('narrow UI overrides: PASS')
