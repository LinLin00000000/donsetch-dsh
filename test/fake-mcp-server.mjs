#!/usr/bin/env node
/**
 * Fake donsetch MCP daemon for tests: a real stdio JSON-RPC peer with
 * working tools, a bad tool name, per-call stderr noise, crash and
 * slow tools, and cancellation marker files so tests can assert the
 * server was really told to stop. A dedicated reader loop keeps
 * parsing stdin while a tool call is in flight, exactly like the
 * real donsetch server: cancellation is honoured mid-call.
 *
 * Env:
 *   FAKE_CANCEL_LOG  path written on notifications/cancelled
 *   FAKE_BOOT_LOG    path appended on every initialize
 *   FAKE_RAW_LOG     path appended with every inbound frame
 *   FAKE_ALL_LOG     path appended with every inbound method
 *   FAKE_CRASH_LOG   path written with any uncaught exception
 */
import { appendFileSync, writeFileSync } from 'node:fs'

process.on('uncaughtException', (err) => {
  try {
    process.stderr.write('UNCAUGHT: ' + String(err?.stack ?? err) + '\n')
    writeFileSync(process.env.FAKE_CRASH_LOG ?? '/dev/null', String(err?.stack ?? err))
  } catch {
    // Nothing left to do.
  }
  process.exit(1)
})

const logLine = (envKey, text) => {
  if (!process.env[envKey]) return
  try {
    appendFileSync(process.env[envKey], text + '\n')
  } catch {
    // Logging must never break the protocol.
  }
}

const emit = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const TOOLS = [
  { name: 'echo_tool', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail_tool', description: 'always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow_tool', description: 'slow', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash_tool', description: 'kills the server', inputSchema: { type: 'object', properties: {} } },
  { name: 'has space!!', description: 'illegal name', inputSchema: { type: 'object', properties: {} } },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Reader half: parse newline frames into a message queue, handling
// cancellation inline so the consumer's blocked work can be unblocked.
const queue = []
const cancelledIds = new Set()
let queueWaiters = []
let buffer = ''

const parseLine = (line) => {
  if (!line.trim()) return
  logLine('FAKE_RAW_LOG', 'RAW: ' + line.slice(0, 200))
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  logLine('FAKE_ALL_LOG', msg.method)
  if (msg.method === 'notifications/cancelled') {
    const id = msg.params?.id
    if (typeof id === 'number') cancelledIds.add(id)
    logLine('FAKE_CANCEL_LOG', String(id ?? '?'))
    return // handled inline; the consumer does not need it
  }
  process.stderr.write('noise: handled ' + msg.method + '\n')
  queue.push(msg)
  const waiters = queueWaiters
  queueWaiters = []
  for (const w of waiters) w()
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) parseLine(line)
})
process.stdin.on('end', () => process.exit(0))

const nextMessage = () => {
  if (queue.length > 0) return Promise.resolve(queue.shift())
  return new Promise((resolve) => queueWaiters.push(() => resolve(queue.shift())))
}

async function handleCall(msg) {
  const name = msg.params?.name ?? ''
  if (name === 'echo_tool') {
    await sleep(50)
    emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params?.arguments?.text ?? '') }] } })
  } else if (name === 'fail_tool') {
    emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom: upstream refused' }], isError: true } })
  } else if (name === 'slow_tool') {
    await sleep(4000)
    if (!cancelledIds.has(msg.id)) {
      emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow done' }] } })
    }
  } else if (name === 'crash_tool') {
    process.exit(7)
  } else {
    emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } })
  }
}

// Consumer half: sequential framing, concurrent tool calls (the real
// donsetch server handles tools/call concurrently on tokio tasks).
for (;;) {
  const msg = await nextMessage()
  switch (msg.method) {
    case 'initialize': {
      logLine('FAKE_BOOT_LOG', 'boot')
      emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'donsetch', version: '9.9.9-test' } } })
      break
    }
    case 'notifications/initialized':
      break
    case 'tools/list':
      emit({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
      break
    case 'tools/call': {
      void handleCall(msg)
      break
    }
    case 'notifications/cancelled':
      break // handled inline by the reader
    default:
      break
  }
}