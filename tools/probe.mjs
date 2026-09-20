/**
 * Runs one expression inside the page and prints what it returns.
 *
 *   node tools/probe.mjs "__flipza.renderer.pieces.length"
 *   node tools/probe.mjs "Object.keys(__flipza.assets.toppings)" 6
 *
 * The second argument is how many seconds to wait before evaluating, which
 * matters because most of the scene streams in after the first frame.
 *
 * `window.__flipza` only exists in a dev build (see OrderScene). This is for
 * answering "what does the renderer actually think is there" without adding a
 * console.log, rebuilding, and taking another screenshot to find out.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const [expr = '1 + 1', waitFor = '4'] = process.argv.slice(2)

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(fs.existsSync)

const BASE = process.env.URL || 'http://127.0.0.1:5173/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const port = 9700 + (process.pid % 200)
const profile = path.join(os.tmpdir(), 'flipza-probe-' + Date.now().toString(36))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

let targets
for (let i = 0; i < 80 && !targets; i++) {
  await sleep(250)
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  } catch {
    // not up yet
  }
}

const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let n = 0
const pending = {}
const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (pending[m.id]) {
    pending[m.id](m.result || m.error)
    delete pending[m.id]
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(
      `[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    )
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[throw] ' + (m.params.exceptionDetails.exception?.description || '?'))
  }
}
const send = (method, params = {}) =>
  new Promise((r) => {
    pending[++n] = r
    ws.send(JSON.stringify({ id: n, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await send('Page.navigate', { url: `${BASE}?motion=on&cb=${Date.now()}` })
await sleep(Number(waitFor) * 1000)

const r = await send('Runtime.evaluate', {
  // Resolved *before* it is stringified, so an async expression returns what it
  // resolves to rather than the JSON of a pending promise, which is `{}` and
  // looks exactly like an object with nothing in it.
  expression: `Promise.resolve((async () => { try { return (${expr}) } catch (e) { return 'ERROR: ' + e.message } })()).then(v => JSON.stringify(v))`,
  returnByValue: true,
  awaitPromise: true,
})

console.log('=>', r.result?.value ?? JSON.stringify(r))
if (logs.length) {
  console.log('--- page log')
  for (const l of logs.slice(0, 20)) console.log(l)
}

ws.close()
chrome.kill()
try {
  fs.rmSync(profile, { recursive: true, force: true })
} catch {
  // the browser may still hold it; it is in the temp directory
}
process.exit(0)
