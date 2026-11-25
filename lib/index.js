/**
 * 服务端半:心跳、会话扫描、增量推送、重试队列、配置读写、给客户端半的代理路由。
 *
 * 设计原则:
 * - 网络请求全部异步,失败进重试队列;区分「暂时性错误(重试)」与「永久性错误(丢弃)」
 * - 水位随 relay 地址隔离:换 relay 后重新全量推送,否则新库永远是空的
 * - 按文件 mtime 增量扫描:未变化的会话不再解压解析,避免每轮全量阻塞事件循环
 * - 卸载时清理定时器、路由和退避等待,不留残留
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { scanAllSessions, listSessionFiles, parseSessionFile } from './scan.js'
import { createRelayClient } from './relay-client.js'

export const name = 'dsh-cross-device'
export const inject = ['webServer']

const STATE_DIR = join(homedir(), '.dsh', 'cross-device')
const CONFIG_FILE = join(STATE_DIR, 'config.json')
const STATE_FILE = join(STATE_DIR, 'state.json')

const HEARTBEAT_MS = 25000
const SCAN_MS = 15000
const MAX_TRIES = 3
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 413, 422])

function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureDir()
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows 上无此语义 */
  }
}

function loadConfig() {
  const cfg = readJson(CONFIG_FILE, null)
  if (cfg && cfg.device_id) return cfg
  const fresh = {
    relay_url: '',
    relay_token: '',
    device_id: randomUUID(),
    device_name: hostname(),
    enabled: false,
  }
  writeJson(CONFIG_FILE, fresh)
  return fresh
}

function loadState() {
  const s = readJson(STATE_FILE, null) || {}
  if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {}
  if (!s.files || typeof s.files !== 'object') s.files = {}
  return s
}

export function apply(ctx) {
  ensureDir()
  let config = loadConfig()
  const state = loadState()

  const client = createRelayClient({ getConfig: () => config })

  let stopped = false
  let queued = []
  let draining = false
  let backoffTimer = null
  let backoff = 1000

  function configured() {
    return Boolean(config.enabled && config.relay_url && config.relay_token)
  }

  /** 队列条目:{ fn, tries, key }。同 key 只保留最新一个,避免断网期间无限堆积。 */
  function enqueue(key, fn) {
    if (stopped) return
    queued = queued.filter((e) => e.key !== key)
    queued.push({ fn, tries: 0, key })
    if (queued.length > 200) queued.shift()
    void drain()
  }

  function scheduleRetry() {
    if (stopped || backoffTimer) return
    backoffTimer = setTimeout(() => {
      backoffTimer = null
      void drain()
    }, backoff)
    backoff = Math.min(backoff * 2, 60000)
  }

  async function drain() {
    if (draining || stopped) return
    draining = true
    try {
      while (queued.length && !stopped) {
        const entry = queued[0]
        try {
          await entry.fn()
          queued = queued.filter((e) => e !== entry)
          backoff = 1000
        } catch (err) {
          entry.tries += 1
          const status = err && err.status
          const permanent = PERMANENT_STATUS.has(status) || entry.tries >= MAX_TRIES
          ctx.logger?.warn?.('cross-device: relay call failed ' + (status || '') + ' try ' + entry.tries + ': ' + (err && err.message))
          // 永久性错误或超过重试上限:丢弃这一条,避免队头永久阻塞后续同步
          if (permanent) {
            queued = queued.filter((e) => e !== entry)
            backoff = 1000
            continue
          }
          scheduleRetry()
          break
        }
      }
    } finally {
      draining = false
    }
  }

  async function beat() {
    if (stopped || !configured()) return
    try {
      await client.heartbeat({
        device_id: config.device_id,
        device_name: config.device_name,
        platform: 'macos',
      })
    } catch {
      /* 心跳失败不重试,下一轮自然重来 */
    }
  }

  /** 换 relay 就必须重推:水位按 relay 地址隔离。 */
  function syncRelayScope() {
    if (state.relay_url !== config.relay_url) {
      state.relay_url = config.relay_url
      state.sessions = {}
      state.files = {}
      writeJson(STATE_FILE, state)
    }
  }

  let scanning = false

  async function scanAndPush() {
    if (stopped || scanning || !configured()) return
    scanning = true
    try {
      syncRelayScope()
      const files = listSessionFiles()
      const metas = []

      for (const file of files) {
        let mtime = 0
        try {
          mtime = statSync(file).mtimeMs
        } catch {
          continue
        }
        const known = state.files[file]
        // 文件没变就跳过解压解析:全量解压在历史多时会阻塞事件循环
        if (known && known.mtime === mtime && state.sessions[known.session_id]) {
          const s = state.sessions[known.session_id]
          metas.push({ session_id: known.session_id, title: s.title, updated_at: s.updated_at })
          continue
        }

        const parsed = parseSessionFile(file)
        if (!parsed) continue
        state.files[file] = { mtime, session_id: parsed.session_id }
        const prev = state.sessions[parsed.session_id] || { pushed: 0 }
        state.sessions[parsed.session_id] = {
          pushed: prev.pushed || 0,
          title: parsed.title,
          updated_at: parsed.updated_at,
        }
        metas.push({ session_id: parsed.session_id, title: parsed.title, updated_at: parsed.updated_at })

        const pending = parsed.messages.filter((m) => m.seq > (prev.pushed || 0))
        if (!pending.length) continue
        const lastSeq = pending[pending.length - 1].seq
        const sid = parsed.session_id
        enqueue('msg:' + sid, async () => {
          const result = await client.pushMessages(sid, {
            device_id: config.device_id,
            messages: pending.map((m) => ({
              msg_id: m.msg_id,
              role: m.role,
              content: m.content,
              created_at: m.created_at,
            })),
          })
          // 服务端必须回执 inserted/duplicates 才推进水位;响应异常时宁可重推
          if (!result || !Array.isArray(result.inserted) || !Array.isArray(result.duplicates)) {
            throw new Error('invalid_push_response')
          }
          state.sessions[sid] = Object.assign({}, state.sessions[sid], { pushed: lastSeq })
          writeJson(STATE_FILE, state)
        })
      }

      if (metas.length) {
        enqueue('meta', async () => {
          await client.syncSessions({ device_id: config.device_id, sessions: metas })
        })
      }
      writeJson(STATE_FILE, state)
    } catch (err) {
      ctx.logger?.warn?.('cross-device: scan failed: ' + (err && err.message))
    } finally {
      scanning = false
    }
  }  /* ── 给客户端半用的本机路由 ───────────────────────────────────────────── */

  function json(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.length),
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  /**
   * 本机接口防护。宿主不提供逐路由鉴权,所以自己做两层:
   * 1) 只接受同源请求(挡掉恶意网页发起的 CSRF);
   * 2) 写操作必须带 x-cross-device 头(跨源需预检,浏览器不会自动带上)。
   * 本机其它进程仍可访问,真正的兜底是「换 relay 必须重输 token」。
   */
  function guard(req, res) {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
      json(res, 403, { error: { code: 'forbidden_origin' } })
      return false
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-cross-device'] !== '1') {
      json(res, 403, { error: { code: 'csrf_header_required' } })
      return false
    }
    return true
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > 1024 * 1024) throw new Error('payload_too_large')
      chunks.push(c)
    }
    if (!size) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/cross-device/config',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method === 'GET') {
          json(res, 200, {
            relay_url: config.relay_url,
            device_id: config.device_id,
            device_name: config.device_name,
            enabled: config.enabled,
            token_configured: Boolean(config.relay_token),
          })
          return
        }
        if (req.method === 'POST') {
          try {
            const body = await readBody(req)
            const nextRelay = typeof body.relay_url === 'string' ? body.relay_url.trim() : config.relay_url
            if (nextRelay && !/^https?:\/\//.test(nextRelay)) {
              json(res, 400, { error: { code: 'invalid_relay_url' } })
              return
            }
            if (nextRelay && nextRelay !== config.relay_url && !body.relay_token) {
              json(res, 400, { error: { code: 'token_required_on_relay_change' } })
              return
            }
            if (typeof body.relay_url === 'string') config.relay_url = nextRelay
            if (typeof body.relay_token === 'string' && body.relay_token) config.relay_token = body.relay_token.trim()
            if (typeof body.device_name === 'string' && body.device_name) config.device_name = body.device_name.trim()
            if (typeof body.enabled === 'boolean') config.enabled = body.enabled
            writeJson(CONFIG_FILE, config)
            if (configured()) void beat()
            json(res, 200, { ok: true, enabled: config.enabled })
          } catch (err) {
            json(res, 400, { error: { code: 'invalid_body', message: String(err && err.message) } })
          }
          return
        }
        json(res, 405, { error: { code: 'method_not_allowed' } })
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/cross-device/sidebar',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!configured()) {
          json(res, 200, { devices: [], disabled: true })
          return
        }
        try {
          json(res, 200, await client.sidebar())
        } catch (err) {
          json(res, err.status === 401 ? 401 : 502, { error: { code: err.message || 'relay_error' } })
        }
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/cross-device/messages',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (!configured()) {
          json(res, 200, { session_id: null, messages: [], latest_seq: 0, has_more: false })
          return
        }
        try {
          const url = new URL(req.url, 'http://local')
          const sessionId = url.searchParams.get('session_id')
          const sinceSeq = Number(url.searchParams.get('since_seq') || 0)
          const limit = Number(url.searchParams.get('limit') || 100)
          if (!sessionId) {
            json(res, 400, { error: { code: 'session_id_required' } })
            return
          }
          json(res, 200, await client.messages(sessionId, sinceSeq, limit))
        } catch (err) {
          json(res, 502, { error: { code: err.message || 'relay_error' } })
        }
      },
    }),
  )

  /* ── 定时器与卸载清理 ─────────────────────────────────────────────────── */
  const timers = []
  timers.push(setInterval(() => void beat(), HEARTBEAT_MS))
  timers.push(setInterval(() => void scanAndPush(), SCAN_MS))
  void beat()
  void scanAndPush()

  ctx.effect(() => () => {
    stopped = true
    for (const t of timers) clearInterval(t)
    if (backoffTimer) clearTimeout(backoffTimer)
    backoffTimer = null
    queued = []
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 路由可能已被宿主一并回收 */
      }
    }
  }, 'dsh-cross-device: timers and routes')
}
