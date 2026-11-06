import assert from 'node:assert/strict'
import { parseTunnelUrl } from '../lib/cloudflared.js'

assert.equal(parseTunnelUrl('INF https://api.trycloudflare.com https://green-fox-1.trycloudflare.com'), 'https://green-fox-1.trycloudflare.com')
assert.equal(parseTunnelUrl('https://www.trycloudflare.com https://update.trycloudflare.com'), undefined)
assert.equal(parseTunnelUrl('https://green-fox-1.trycloudflare.com/path'), 'https://green-fox-1.trycloudflare.com')
console.log('tunnel resolve: PASS')
