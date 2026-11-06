/**
 * 静态契约 C1 / C2 / C5：改名、新组件挂载、locale 键集、旧确认卡片彻底移除。
 *
 * 这些是文本级断言：client.js 由宿主浏览器按源文件加载（无构建步骤），
 * locale JSON 由 Cordis 在未激活插件时读取显示元数据，因此文本本身就是契约。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

let passed = 0
const pass = (name) => {
  passed += 1
  console.log('PASS', name)
}

const client = read('../client.js')

// C1：插件在 DSH 插件列表/设置里显示「手机分身」；绑定密码卡片已挂载；旧配对确认 UI 消失。
{
  assert.match(client, /settingsTitle: ZH \? '手机分身' : 'Phone Mirror'/)
  assert.match(client, /bindTitle: ZH \? '绑定密码'/)
  assert.match(client, /h\(BindingCard, null\)/)
  assert.doesNotMatch(client, /pair-request-resolved/)
  assert.doesNotMatch(client, /PairCard/)
  assert.doesNotMatch(client, /pairCode/)
  assert.doesNotMatch(client, /pairHint/)
  assert.doesNotMatch(client, /手机桥接|Mobile Bridge|配对码|扫码配对/)
  pass('C1 rename to 手机分身, BindingCard mounted, old pairing UI removed')
}

// C2：SakuraFrp 卡片与 Tailscale 国外用户备注并存。
{
  assert.match(client, /function SakuraCard\(\)/)
  assert.match(client, /h\(SakuraCard, null\)/)
  assert.match(client, /sfTitle: ZH \? 'SakuraFrp 免费穿透/)
  assert.match(client, /tsNote: ZH/)
  assert.match(client, /仅适合国外用户/)
  assert.match(client, /h\(TailscaleCard, null\)/)
  assert.match(client, /T\.tsNote\)/)
  assert.match(client, /h\(CloudflareCard, null\)/)
  assert.match(client, /h\(ChannelCard, null\)/)
  pass('C2 SakuraCard + overseas-only Tailscale note, all legacy cards still mounted')
}

// C5：locale 显示元数据与 pair 键集。
{
  const zh = JSON.parse(read('../locale/zh.json'))
  const en = JSON.parse(read('../locale/en.json'))
  assert.equal(zh.meta.title, '手机分身')
  assert.equal(en.meta.title, 'Phone Mirror')
  for (const locale of [zh, en]) {
    assert.equal('wait' in locale.pair, false)
    assert.equal('code' in locale.pair, false)
    assert.equal('noCode' in locale.pair, false)
    assert.equal('mismatch' in locale.pair, false)
    assert.equal('expires' in locale.pair, false)
    for (const key of ['title', 'h1', 'hint', 'password', 'name', 'url', 'qrAlt', 'wrongPassword', 'tooMany', 'busy', 'limit', 'submit']) {
      assert.equal(typeof locale.pair[key], 'string', `locale pair.${key} must be a string`)
    }
  }
  pass('C5 locale metadata + pair key set (no wait/code/noCode/mismatch/expires)')
}

// 附加：PWA 安装名与图标无障碍标签同步改名（手机「添加到主屏幕」看到的名字）。
{
  const pwa = read('../lib/pwa.js')
  const icon = read('../icon.svg')
  assert.match(pwa, /name: '手机分身'/)
  assert.doesNotMatch(pwa, /Mobile Bridge/)
  assert.match(icon, /aria-label="手机分身"/)
  pass('C6 PWA manifest + icon renamed to 手机分身')
}

// 附加：旧确认轮询/自动同意逻辑在生产代码里没有半删残留（历史文档与测试断言除外）。
{
  const production = ['../index.js', '../client.js', '../lib/routes.js', '../lib/edge.js', '../lib/pairing.js', '../lib/push.js', '../lib/host-login.js']
    .map(read).join('\n')
  for (const stale of ['/pair/state', 'isStatePoll', 'confirmWaitPage', 'autoApprovePairing', 'pairConfirmTtlMs', 'pairingMaxAttempts', '重新扫码', '审批/配对产生时']) {
    assert.equal(production.includes(stale), false, `stale token remains: ${stale}`)
  }
  assert.doesNotMatch(read('../client.js'), /\(或扫描\)|\(or scan\)/)
  pass('C7 no half-removed scan/confirm-poll leftovers in production code')
}

// 附加：cordis.patch.yml 不再带旧确认/自动同意开关，新增 SakuraFrp 配置键。
{
  const patch = read('../cordis.patch.yml')
  assert.doesNotMatch(patch, /autoApprovePairing/)
  assert.doesNotMatch(patch, /pairConfirmTtlMs/)
  assert.match(patch, /sakuraToken/)
  assert.match(patch, /sakuraTunnelId/)
  assert.match(patch, /sakuraBin/)
  assert.match(patch, /sakuraDomain/)
  assert.match(patch, /tunnelMode: 'quick'/)
  pass('patch config: old auto-approve removed, SakuraFrp keys added, quick still default')
}

console.log(`\n${passed} checks passed`)
