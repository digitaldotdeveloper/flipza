/**
 * Drives the site through Chrome DevTools Protocol and screenshots it.
 *
 *   node tools/shot.mjs <scene> [W] [H]
 *   node tools/shot.mjs order 390 844
 *   URL=https://user.github.io/flipza/ node tools/shot.mjs flavour 390 844
 *
 * Scenes are listed in SCENES below; `all` runs every one of them.
 *
 * Device metrics go through `Emulation.setDeviceMetricsOverride`, not through
 * `--window-size`: a headless window is not a phone, and shooting one at
 * 390x844 gives a desktop layout scaled down rather than the layout a phone
 * actually gets. This is the difference between checking the mobile build and
 * checking a small picture of the desktop build.
 *
 * Every URL carries `?motion=on`. The site honours `prefers-reduced-motion`,
 * Windows Server has "Show animations in Windows" off by default, and a
 * screenshot taken under reduce would show a site that never moves - which is
 * exactly the failure this is meant to catch, so it must be ruled out first.
 * It also carries a cache-buster, because a deployed page behind a CDN will
 * happily serve the version before the one being checked.
 *
 * Own Chrome profile and its own port per run: a stale browser left behind by
 * an earlier run answers /json with dead targets, and the script then attaches
 * to a page that will never paint.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const [scene = 'all', W = '1440', H = '900'] = process.argv.slice(2)

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(fs.existsSync)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, '_shots')
const BASE = process.env.URL || 'http://127.0.0.1:5173/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Each scene is a list of steps run in order.
 *
 *   wait   seconds
 *   click  CSS selector - the nth match, 1-based, with `|n` (resets the clock)
 *   at     seconds since the last click, then a filename suffix
 *   shot   filename suffix, right now
 *
 * `at` exists because a screenshot is not free: capturing a 390x844 page at
 * 2x takes a few hundred milliseconds, and a scene built out of `wait` steps
 * drifts further behind with every frame it takes - which is exactly the part
 * of a two-second animation that matters. `at` waits until the clock says so,
 * whatever the capture before it cost.
 */
const SCENES = {
  loading: [['shot', 'a-loading']],
  idle: [
    ['wait', 3.2],
    ['shot', 'b-idle'],
  ],
  flavour: [
    ['wait', 3],
    ['click', '.chips--flavour .chip|4'],
    ['wait', 0.3],
    ['shot', 'c-mid-toss'],
    ['wait', 0.9],
    ['shot', 'd-landed'],
  ],
  size: [
    ['wait', 3],
    ['click', '.chips--flavour .chip|2'],
    ['wait', 1],
    ['click', '.rail__step|2'],
    ['wait', 0.7],
    ['click', '.chips--size .chip|3'],
    ['wait', 0.9],
    ['shot', 'e-size-large'],
  ],
  extras: [
    ['wait', 3],
    ['click', '.rail__step|3'],
    ['wait', 0.7],
    ['click', '.chips--extras .chip|2'],
    ['wait', 0.42],
    ['shot', 'f-raining'],
    ['click', '.chips--extras .chip|4'],
    ['wait', 0.5],
    ['shot', 'g-raining-2'],
  ],
  add: [
    ['wait', 3],
    ['click', '.rail__step|3'],
    ['wait', 0.6],
    ['click', '.cta--go'],
    ['at', 0.5, 'h-box-in'],
    ['at', 0.78, 'i-dropping'],
    ['at', 0.95, 'j-lid'],
    ['at', 1.35, 'k-leaving'],
  ],
  order: [
    ['wait', 3],
    ['click', '.rail__step|3'],
    ['wait', 0.6],
    ['click', '.cta--go'],
    ['at', 2.8, 'l-order'],
  ],
  placed: [
    ['wait', 3],
    ['click', '.rail__step|3'],
    ['wait', 0.6],
    ['click', '.cta--go'],
    ['wait', 2.6],
    ['click', '.cta--go'],
    ['wait', 1.6],
    ['shot', 'l-placed'],
  ],
  /** Four frames a tenth of a second apart - the fire has to differ between them. */
  fire: [
    ['wait', 3],
    ['shot', 'm-fire-1'],
    ['wait', 0.14],
    ['shot', 'm-fire-2'],
    ['wait', 0.14],
    ['shot', 'm-fire-3'],
    ['wait', 0.14],
    ['shot', 'm-fire-4'],
  ],
}

const ALL = ['idle', 'flavour', 'size', 'extras', 'add', 'order', 'placed', 'fire']

async function connect(port) {
  let targets
  for (let i = 0; i < 80 && !targets; i++) {
    await sleep(250)
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    } catch {
      // browser not up yet
    }
  }
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let n = 0
  const pending = {}
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pending[m.id]) {
      pending[m.id](m.result || m.error)
      delete pending[m.id]
    }
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending[++n] = r
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  return { ws, send }
}

;(async () => {
  const mobile = +W < 760
  const port = 9500 + (process.pid % 300)
  const profile = path.join(os.tmpdir(), 'flipza-cdp-' + Date.now().toString(36))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' }
  )

  const { ws, send } = await connect(port)
  await send('Page.enable')
  await send('Runtime.enable')

  const errors = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || 'exception')
    }
    // console.error is how the loader reports a stream that failed half way,
    // and that failure is silent on screen - the site keeps working, just
    // without whatever never arrived.
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  })

  fs.mkdirSync(outDir, { recursive: true })
  const scenes = scene === 'all' ? ALL : [scene]

  for (const name of scenes) {
    const steps = SCENES[name]
    if (!steps) {
      console.error(`unknown scene ${name}; try ${Object.keys(SCENES).join(', ')} or all`)
      process.exit(1)
    }

    await send('Emulation.setDeviceMetricsOverride', {
      width: +W,
      height: +H,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile,
    })
    await send('Page.navigate', { url: `${BASE}?motion=on&cb=${Date.now()}` })
    await sleep(600)

    let mark = Date.now()
    for (const [op, arg, label] of steps) {
      if (op === 'wait') await sleep(arg * 1000)
      else if (op === 'at') {
        const left = arg * 1000 - (Date.now() - mark)
        if (left > 0) await sleep(left)
      }
      if (op === 'shot' || op === 'at') {
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        const file = path.join(outDir, `${name}-${op === 'at' ? label : arg}-${W}x${H}.png`)
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
        console.log('saved', path.relative(root, file))
      } else if (op === 'click') {
        const [sel, nth] = String(arg).split('|')
        const r = await send('Runtime.evaluate', {
          expression: `(() => {
            const els = document.querySelectorAll(${JSON.stringify(sel)})
            const el = els[${nth ? Number(nth) - 1 : 0}]
            if (!el) return 'missing ' + ${JSON.stringify(arg)}
            el.click()
            return 'ok'
          })()`,
          returnByValue: true,
        })
        if (r.result?.value !== 'ok') console.error('  click:', r.result?.value)
        mark = Date.now()
      }
    }
  }

  if (errors.length) {
    console.error('page errors:')
    for (const e of errors) console.error('  ' + e.split('\n')[0])
  }

  ws.close()
  chrome.kill()
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {
    // the browser may still hold the profile; it is in the temp directory
  }
  process.exit(errors.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
