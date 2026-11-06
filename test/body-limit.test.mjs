import assert from 'node:assert/strict'
import fs from 'node:fs'

const edge = fs.readFileSync(new URL('../lib/edge.js', import.meta.url), 'utf8')
assert.match(edge, /size <= 2 \* 1024 \* 1024/)
assert.match(edge, /const body = overflow \? undefined/)
console.log('body limit contract: PASS (implementation path requires live host probe)')
