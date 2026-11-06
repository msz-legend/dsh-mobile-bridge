import assert from 'node:assert/strict'
import fs from 'node:fs'

const routes = fs.readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
const edge = fs.readFileSync(new URL('../lib/edge.js', import.meta.url), 'utf8')
assert.match(routes, /x-dmb-forwarded-for.*!== undefined/)
assert.match(routes, /return isLoopback\(req\.socket\.remoteAddress\)/)
assert.match(edge, /headers\['x-dmb-forwarded-for'\] = req\.socket\.remoteAddress/)
assert.match(edge, /res\.writeHead\(302/)
console.log('routes security contract: PASS')
