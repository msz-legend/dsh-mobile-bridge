/** 契约：client.js 必须包含宿主提问卡片的窄屏适配覆盖规则，以及 rail 空白区展开提示。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
assert.match(client, /html\[data-dmb-narrow="1"\] \.wnLwla_frame/)
assert.match(client, /html\[data-dmb-narrow="1"\] \.wnLwla_card\{width:100%!important;max-width:100%!important/)
assert.match(client, /\.wnLwla_optionCopy\{display:block!important;white-space:normal!important/)
assert.match(client, /\.dmb-rail-hint\{position:fixed/)
assert.match(client, /function installRailOpenShortcut/)
console.log('narrow UI overrides: PASS')
