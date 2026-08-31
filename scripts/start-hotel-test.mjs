#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = String(process.env.HOTEL_TEST_PORT || '3111').trim()
const runtimeDirectory = resolve(
  root,
  process.env.HOTEL_TEST_RUNTIME_DIR || 'runtime/hotel-test-3111',
)

mkdirSync(runtimeDirectory, { recursive: true })

const childEnv = {
  ...process.env,
  PORT: port,
  QWAUDIO_CONFIG_DIR: runtimeDirectory,
  QWEN_AUDIO_AGENT_RUNTIME_ROOT: root,
  QWEN_AUDIO_GATEWAY_OWNER: process.env.QWEN_AUDIO_GATEWAY_OWNER || 'hotel-test-3111',
  QWEN_AUDIO_AGENT_TOOL_PROFILE: 'hotel-direct',
  QWEN_AUDIO_CONTEXT_ID: process.env.QWEN_AUDIO_CONTEXT_ID
    || 'hotel-10082-daily',
  QWEN_AUDIO_CONTEXT_MODE: process.env.QWEN_AUDIO_CONTEXT_MODE || 'mock',
  AGENT_PROTOCOL: 'none',
}

const child = spawn(
  process.execPath,
  ['server/src/index.mjs'],
  {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
  },
)

const stop = signal => {
  if (!child.killed) child.kill(signal)
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
