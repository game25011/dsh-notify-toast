/**
 * dsh-notify-toast — Host-side Windows native toast manager.
 *
 * A small PowerShell/C# helper shows a real Windows toast with a bound
 * <progress> bar, updates it while the notification is displayed, and posts the click
 * activation back to a per-Host loopback callback. The Host owns the callback
 * token and never trusts arbitrary callback URLs from the client.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { basename, join } from 'node:path'

const KINDS = new Set(['question', 'approval', 'complete', 'test'])
const GROUP = 'dsh-notify-toast'
const MAX_BODY = 4096
const SUBMIT_TIMEOUT_MS = 12000
const WARM_TIMEOUT_MS = 20000
const MAX_ACTIVE_TOASTS = 8
const DURATION_MIN_MS = 3000
const DURATION_MAX_MS = 30000

function clampDuration(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 8000
  return Math.max(DURATION_MIN_MS, Math.min(DURATION_MAX_MS, Math.round(number)))
}

function jsonResponse(res, status, value) {
  try {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    try { res.destroy() } catch { /* ignore */ }
  }
}

function sameToken(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

/**
 * @param {object} options
 * @param {string} options.scriptPath absolute path to native-toast.ps1
 * @param {(sessionId: string, notificationId: string) => void} options.onActivate
 * @param {(message: string, error?: unknown) => void} [options.logWarn]
 * @param {string} [options.powershellPath]
 * @param {string} [options.aumid]
 */
export function createNativeToastManager(options) {
  const {
    scriptPath,
    onActivate,
    logWarn = () => {},
    powershellPath = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    aumid = 'electron.app.' + basename(process.execPath || 'DeepSeek Harness.exe', '.exe'),
    spawnProcess = spawn,
  } = options || {}

  let disposed = false
  let server = null
  let serverReady = null
  let callbackUrl = null
  let warmPromise = null
  let warmChild = null
  const token = randomBytes(32).toString('hex')
  const active = new Map()

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new Error('activation body too large'))
          try { req.destroy() } catch { /* ignore */ }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  async function handleActivation(req, res) {
    if (req.method !== 'POST' || req.url !== '/activate') {
      jsonResponse(res, 404, { ok: false })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      jsonResponse(res, 400, { ok: false })
      return
    }
    if (!body || !sameToken(body.token, token)) {
      jsonResponse(res, 403, { ok: false })
      return
    }
    const notificationId = typeof body.notificationId === 'string' ? body.notificationId : ''
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    let record = null
    for (const candidate of active.values()) {
      if (candidate.notificationId === notificationId) { record = candidate; break }
    }
    if (!record || record.activated) {
      jsonResponse(res, 200, { ok: true, ignored: true })
      return
    }
    record.activated = true
    try {
      onActivate(sessionId, notificationId)
    } catch (error) {
      logWarn('native toast activation callback failed', error)
    }
    jsonResponse(res, 200, { ok: true })
  }

  function ensureServer() {
    if (serverReady) return serverReady
    serverReady = new Promise((resolve, reject) => {
      const candidate = createServer((req, res) => {
        handleActivation(req, res).catch((error) => {
          logWarn('native toast activation server error', error)
          jsonResponse(res, 500, { ok: false })
        })
      })
      candidate.on('error', (error) => {
        serverReady = null
        reject(error)
      })
      candidate.listen(0, '127.0.0.1', () => {
        server = candidate
        const address = candidate.address()
        if (!address || typeof address === 'string') {
          candidate.close()
          serverReady = null
          reject(new Error('activation server has no TCP address'))
          return
        }
        callbackUrl = 'http://127.0.0.1:' + address.port + '/activate'
        resolve()
      })
    })
    return serverReady
  }

  function killRecord(record) {
    if (!record) return
    try { record.child.kill() } catch { /* ignore */ }
  }

  /**
   * Compile/load the C# helper without showing a toast. The helper cache is
   * source-hash keyed; the first real notification should not pay the cold
   * csc cost. Failures are non-fatal and leave normal delivery/fallback intact.
   */
  function warm() {
    if (disposed) return Promise.resolve(false)
    if (warmPromise) return warmPromise
    warmPromise = new Promise((resolve) => {
      let child
      try {
        child = spawnProcess(
          powershellPath,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-WarmOnly'],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch {
        resolve(false)
        return
      }
      warmChild = child
      let done = false
      let output = ''
      let stderr = ''
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (warmChild === child) warmChild = null
        try { child.kill() } catch { /* ignore */ }
        resolve(value)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish(false)
      }, WARM_TIMEOUT_MS)
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
        if (output.includes('warm')) finish(true)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', () => finish(false))
      child.on('exit', () => {
        if (output.includes('warm')) finish(true)
        else {
          if (stderr) logWarn('native toast prewarm failed: ' + stderr.slice(0, 800))
          finish(false)
        }
      })
    })
    return warmPromise
  }

  async function show(input) {
    if (disposed) return { ok: false, reason: 'disposed' }
    const kind = input && typeof input.kind === 'string' ? input.kind : ''
    if (!KINDS.has(kind)) return { ok: false, reason: 'invalid-kind' }
    const title = input && typeof input.title === 'string' ? input.title.slice(0, 256) : ''
    const body = input && typeof input.body === 'string' ? input.body.slice(0, 2048) : ''
    const sessionId = input && typeof input.sessionId === 'string' ? input.sessionId.slice(0, 256) : ''
    const durationMs = clampDuration(input && input.durationMs)
    const progressLabel = input && typeof input.progressLabel === 'string' ? input.progressLabel.slice(0, 32) : ''
    // Warm in the background; the helper itself still handles a cache miss.
    void warm()
    let ready
    try { ready = await ensureServer() } catch (error) { ready = error }
    if (ready instanceof Error || disposed) return { ok: false, reason: 'callback-server-unavailable' }
    if (active.size >= MAX_ACTIVE_TOASTS) {
      const oldest = active.values().next().value
      if (oldest) {
        killRecord(oldest)
        active.delete(oldest.notificationId)
      }
    }
    const notificationId = kind + '-' + Date.now().toString(36) + '-' + randomBytes(4).toString('hex')
    const tag = 'dsh-notify-' + kind + '-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
    const payload = {
      aumid,
      tag,
      group: GROUP,
      title,
      body,
      progressLabel,
      sessionId,
      notificationId,
      callbackUrl,
      token,
      durationMs,
    }
    let child
    try {
      child = spawnProcess(
        powershellPath,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-FromStdin'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (error) {
      return { ok: false, reason: 'spawn-failed', error: String(error && error.message ? error.message : error) }
    }
    const record = { child, notificationId, kind, activated: false }
    active.set(notificationId, record)
    child.stdin.on('error', () => {
      // The helper may exit while the payload is being written.
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 1000)
    })
    child.on('error', () => {
      if (active.get(notificationId) === record) active.delete(notificationId)
    })
    child.on('exit', () => {
      if (active.get(notificationId) === record) active.delete(notificationId)
    })
    const submitted = await new Promise((resolve) => {
      let done = false
      let output = ''
      const finish = (value) => {
        if (done) return
        done = true
        resolve(value)
      }
      const timer = setTimeout(() => {
        killRecord(record)
        finish(false)
      }, SUBMIT_TIMEOUT_MS)
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
        if (output.includes('submitted')) {
          clearTimeout(timer)
          finish(true)
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (!output.includes('submitted')) {
          if (stderr) logWarn('native toast helper failed: ' + stderr)
          finish(false)
        }
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      try {
        child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'))
      } catch {
        clearTimeout(timer)
        finish(false)
      }
    })
    if (!submitted) return { ok: false, reason: 'helper-failed' }
    return { ok: true, id: notificationId, durationMs }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (warmChild) {
      try { warmChild.kill() } catch { /* ignore */ }
      warmChild = null
    }
    for (const record of active.values()) killRecord(record)
    active.clear()
    if (server) {
      try { server.close() } catch { /* ignore */ }
      server = null
    }
    serverReady = null
    callbackUrl = null
  }

  return { show, warm, ensureServer, dispose }
}
