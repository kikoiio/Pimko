import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { currentLogFile, initLogger, log } from '../src/main/logger'

void test('日志写入文件，并在上下文中隐藏 key/token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pimko-log-'))
  try {
    const file = initLogger(root)
    log('info', 'test', 'hello', {
      apiKey: 'should-not-appear',
      nested: { token: 'also-secret', model: 'visible-model' },
    })
    assert.equal(currentLogFile(), file)
    const text = await readFile(file, 'utf8')
    assert.ok(text.includes('hello'))
    assert.ok(text.includes('visible-model'))
    assert.ok(!text.includes('should-not-appear'))
    assert.ok(!text.includes('also-secret'))
    assert.ok(text.includes('***'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
