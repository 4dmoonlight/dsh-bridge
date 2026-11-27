import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const prefix = '/api/cross-device'
const localOrigin = 'https://local.example'
const entrySecret = 'mock-relay-secret_'.padEnd(43, 'A')
const entryHost = '11111111111111111111111111111111.dsh-relay.localhost'
const entryRoot = 'http://' + entryHost + ':59182/dsh-relay-enter'
const entry = entryRoot + '#' + entrySecret
const googleStart = '/web/google/start'
const portalControl = '/web/portal-control'
const googleEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth'
const googleAuthorization = googleEndpoint + '?' + new URLSearchParams({
  client_id: 'bridge.apps.googleusercontent.com', response_type: 'code', scope: 'openid email profile',
  redirect_uri: 'https://hub.example/api/v1/web/google/callback', state: 'opaque-oauth-state'.padEnd(43, 's'),
  nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256',
})
const peer = { device_id: 'peer', device_name: '远程设备', status: 'online', web_enabled: true }
const status = (overrides = {}) => ({
  hub_url: 'https://hub.example/', joined: true, login_provider: 'google', web_error: null,
  remote_control_enabled: false, control_ready: false, devices: [peer], ...overrides,
})
const signedOut = (overrides = {}) => status({ joined: false, login_provider: null, devices: [], ...overrides })
const hubLabel = '中继地址（Hub）'
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { resolve, promise } }

function mount(t, route, options = {}) {
  // The unbuilt plugin only talks to the loader, React hooks and browser APIs.
  // This deliberately small harness keeps all effects and navigation offline.
  const registrations = new Map(), hooks = new Map(), listeners = new Map(), timers = new Set(), requests = []
  let frame, effects, writes = 0, stopped = false
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const slot = hook(() => ({ value: initial }))
      return [slot.value, (change) => { writes++; slot.value = typeof change === 'function' ? change(slot.value) : change }]
    },
    useRef: (current) => hook(() => ({ current })),
    useCallback: (callback) => hook(() => ({ callback })).callback,
    useEffect(effect) {
      hook(() => { const slot = {}; effects.push(() => { slot.cleanup = effect() }); return slot })
    },
  }
  function hook(create) { const index = frame.cursor++; return frame.slots[index] ??= create() }
  function expand(node) {
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      if (!hooks.has(node.type)) hooks.set(node.type, [])
      frame = { slots: hooks.get(node.type), cursor: 0 }
      return expand(node.type(node.props))
    }
    return { ...node, children: node.children.map(expand) }
  }
  const window = {
    location: { origin: localOrigin },
    setInterval(callback) { timers.add(callback); return callback },
    clearInterval(callback) { timers.delete(callback) },
    addEventListener(name, callback) { listeners.set(name, callback) },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name) },
    confirm: options.confirm ?? (() => true),
    open: options.open ?? (() => null),
    __ModuleLoader__: { load({ factory }) {
      const plugin = factory((name) => { assert.equal(name, 'react'); return react })
      assert.ok(plugin.inject.includes('slots'))
      plugin.apply({ slots: { inject: (_name, cb) => cb(), register: (descriptor, Component) => registrations.set(descriptor.name, { descriptor, Component }) } })
    } },
  }
  async function fetch(url, init) {
    const request = { url, path: url.slice(prefix.length), init, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    requests.push(request)
    const response = await route(request)
    const code = response?.http ?? 200
    return { ok: code >= 200 && code < 300, status: code, json: async () => response?.data ?? response }
  }
  runInNewContext(source, { window, fetch, URL, AbortController })
  const main = registrations.get('main')
  assert.equal(main.descriptor.key, 'cross-device')
  assert.equal(registrations.get('sidebar.panellist').descriptor.id, 'cross-device')
  function render() {
    effects = []
    const tree = expand(react.createElement(main.Component))
    for (const effect of effects) effect()
    return tree
  }
  function unmount() {
    if (stopped) return
    stopped = true
    for (const slots of hooks.values()) for (const slot of slots) slot.cleanup?.()
  }
  t.after(() => {
    unmount()
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)
    for (const { url, path, init, body } of requests) {
      assert.match(url, /^\/api\/cross-device\/web\/(?:status|control|portal-control|open|google\/start)$/)
      assert.equal(init.headers['x-cross-device'], '1')
      assert.equal(init.mode, 'same-origin')
      assert.equal(init.credentials, 'same-origin')
      assert.equal(init.redirect, 'error')
      assert.equal(init.cache, 'no-store')
      assert.equal(init.referrerPolicy, [googleStart, '/web/control', portalControl].includes(path) ? 'origin' : undefined)
      assert.equal(init.headers.authorization, undefined)
      if (init.method === 'POST') {
        assert.equal(init.headers['content-type'], 'application/json')
        assert.equal(typeof body, 'object')
        assert.equal(Object.hasOwn(body, 'hub_token'), false)
      } else assert.equal(init.method, 'GET')
    }
  })
  return {
    render, unmount, requests, writes: () => writes,
    tick: () => { for (const callback of timers) callback() },
    focus: () => listeners.get('focus')?.(),
    settle: async () => { await new Promise(setImmediate); return render() },
  }
}

const text = (node) => node && typeof node === 'object' ? node.children.map(text).join('') : typeof node === 'string' ? node : ''
const nodes = (tree, type) => tree && typeof tree === 'object' ? [...(tree.type === type ? [tree] : []), ...tree.children.flatMap((child) => nodes(child, type))] : []
const button = (tree, label) => nodes(tree, 'button').find((node) => text(node) === label || node.props['aria-label'] === label)
const open = (tree) => button(tree, '在新标签页打开 远程设备 的 DSH Web')
const google = (tree) => button(tree, '使用 Google 登录')
const input = (tree, label) => nodes(tree, 'label').find((node) => node.children[0] === label)?.children.find((node) => node?.type === 'input')
const change = (tree, label, value) => input(tree, label).props.onChange({ target: { value } })
const control = (tree) => input(tree, '允许远程控制本机')
const toggle = (tree, checked) => control(tree).props.onChange({ target: { checked } })
const portal = (tree) => input(tree, '允许从服务器网页访问本机')
const togglePortal = (tree, checked) => portal(tree).props.onChange({ target: { checked } })
function popup() {
  const destinations = []
  const tab = {
    opener: {}, closed: false, close() { this.closed = true },
    location: { replace(href) { assert.equal(tab.opener, null); destinations.push(href) } },
  }
  return { tab, destinations }
}

test('shows only same-account Web presence and handles polling, focus, and retry', async (t) => {
  const initial = deferred()
  let next = initial.promise
  const panel = mount(t, () => next)
  assert.match(text(panel.render()), /正在加载跨设备状态/)
  initial.resolve(status({
    email: 'hidden-account@example.test', google_sub: 'hidden-google-subject', access_token: 'hidden-token',
    devices: [
      { ...peer, sessions: [{ title: 'hidden-session' }], email: 'hidden-peer@example.test', web_url: 'https://hidden-peer.example.test' },
      { ...peer, device_id: 'off', device_name: '离线设备', status: 'offline' },
      { ...peer, device_id: 'off-web', device_name: '未开设备', web_enabled: false },
      { device_name: 'hidden-malformed', device_id: 'bad', status: 'surprise', web_enabled: true },
    ],
  }))
  let tree = await panel.settle()
  assert.doesNotMatch(JSON.stringify(tree), /hidden-/)
  assert.deepEqual(nodes(tree, 'li').map((row) => text(row).split('打开 Web')[0]), ['远程设备在线', '离线设备离线', '未开设备在线未开放远程控制'])
  assert.deepEqual(nodes(tree, 'li').map((row) => button(row, '打开 Web').props.disabled), [false, true, true])
  for (const row of nodes(tree, 'li').slice(1)) button(row, '打开 Web').props.onClick()
  assert.deepEqual(panel.requests.map((req) => req.path), ['/web/status'])
  next = { http: 502, data: { error: { code: 'hub_error' } } }
  panel.tick()
  panel.focus() // no duplicate while the poll is in flight
  tree = await panel.settle()
  assert.equal(panel.requests.length, 2)
  assert.match(text(tree), /读取跨设备状态失败.*无法连接中继/)
  assert.equal(nodes(tree, 'li').length, 0)
  next = status({ web_error: 'relay_unavailable' })
  button(tree, '重试').props.onClick()
  tree = await panel.settle()
  assert.match(text(tree), /读取跨设备状态失败.*无法连接远程控制中继/)
  assert.equal(nodes(tree, 'li').length, 0)
  next = status({ login_provider: 'legacy' }) // even unexpected peer data stays hidden
  panel.focus()
  tree = await panel.settle()
  assert.ok(google(tree))
  assert.doesNotMatch(text(tree), /已通过 Google 登录|同账号设备|已配对/)
  assert.equal(nodes(tree, 'li').length, 0)
  button(tree, '刷新').props.onClick()
  await panel.settle()
  assert.equal(panel.requests.length, 5)
})

test('reserves an isolated blank tab synchronously and serializes the click', async (t) => {
  const { tab, destinations } = popup()
  const opening = deferred()
  let reservations = 0
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return status()
    assert.equal(path, '/web/open')
    assert.deepEqual(body, { device_id: 'peer' })
    assert.equal(tab.opener, null)
    return opening.promise
  }, { open(url, target) { assert.equal(url, 'about:blank'); assert.equal(target, '_blank'); reservations++; return tab } })
  panel.render()
  const action = open(await panel.settle()).props.onClick
  action()
  action()
  assert.equal(reservations, 1)
  assert.equal(panel.requests.filter((req) => req.path === '/web/open').length, 1)
  assert.equal(open(panel.render()).props.disabled, true)
  opening.resolve({ entry_url: entry })
  await panel.settle()
  assert.deepEqual(destinations, [entry])
  panel.unmount()
  assert.equal(tab.closed, false)
})

test('rejects unsafe entry URLs and closes pending tabs on error or unmount', async (t) => {
  for (const invalid of [
    undefined, { url: entry },
    entry.replace('http:', 'https:'), entry.replace('http:', 'HTTP:'), localOrigin + '/dsh-relay-enter#' + entrySecret,
    entry.replace(entryHost, '127.0.0.1'), entry.replace(entryHost, entryHost + '.'), entry.replace(entryHost, '2130706433'),
    entry.replace(entryHost, 'localhost'), entry.replace(entryHost, '[::1]'),
    entry.replace(entryHost, entryHost + '@example.test'), entry.replace(entryHost, 'u:password@' + entryHost),
    entry.replace(':59182', ''), entry.replace(':59182', ':80'), entry.replace(':59182', ':0'),
    entry.replace(':59182', ':059182'), entry.replace(':59182', ':65536'),
    entryRoot + '?secret=' + entrySecret + '#' + entrySecret, entryRoot + '?#' + entrySecret,
    entryRoot, entry + '/', entry + '=', entry + 'A', entry.slice(0, -1), entry.replace('#m', '#%6d'),
    ' ' + entry, entry + '\n', entry.replace('/dsh-relay-enter', '/a/../dsh-relay-enter'), entry.replace('/dsh-relay-enter', '/%64sh-relay-enter'),
    entry.replace('dsh-relay-enter', 'dsh-bridge-enter'),
  ]) {
    const { tab, destinations } = popup()
    const panel = mount(t, ({ path }) => path === '/web/status' ? status() : { entry_url: invalid }, { open: () => tab })
    panel.render()
    open(await panel.settle()).props.onClick()
    const tree = await panel.settle()
    assert.match(text(tree), /远端入口无效/)
    assert.doesNotMatch(JSON.stringify(tree), /mock-relay-secret|password|secret=/)
    assert.equal(tab.closed, true, String(invalid))
    assert.deepEqual(destinations, [])
    panel.unmount()
  }
  const { tab, destinations } = popup()
  const opening = deferred()
  const panel = mount(t, ({ path }) => path === '/web/status' ? status() : opening.promise, { open: () => tab })
  panel.render()
  open(await panel.settle()).props.onClick()
  const writes = panel.writes()
  panel.unmount()
  assert.equal(tab.closed, true)
  assert.equal(panel.requests.at(-1).init.signal.aborted, true)
  opening.resolve({ entry_url: entry })
  await new Promise(setImmediate)
  assert.deepEqual(destinations, [])
  assert.equal(panel.writes(), writes)
})

test('uses a second explicit click with noopener and no secret in rendered content if blocked', async (t) => {
  const calls = []
  const panel = mount(t, ({ path }) => path === '/web/status' ? status() : { entry_url: entry }, {
    open(...args) { calls.push(args); return null },
  })
  panel.render()
  open(await panel.settle()).props.onClick()
  const tree = await panel.settle()
  assert.equal(nodes(tree, 'a').length, 0)
  assert.doesNotMatch(JSON.stringify(tree), /mock-relay-secret|dsh-relay-enter/)
  const label = '在新标签页继续打开 远程设备 的 DSH Web'
  button(tree, label).props.onClick()
  assert.deepEqual(calls, [['about:blank', '_blank'], [entry, '_blank', 'noopener,noreferrer']])
  assert.equal(button(panel.render(), label), undefined)
})

test('Google login reserves an isolated tab on click and confirms via local status', async (t) => {
  let current = signedOut()
  const { tab, destinations } = popup()
  const opening = deferred()
  let reservations = 0
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return current
    assert.equal(path, googleStart)
    assert.deepEqual(body, { hub_url: current.hub_url })
    assert.equal(tab.opener, null)
    return opening.promise
  }, { open(url, target) { assert.equal(url, 'about:blank'); assert.equal(target, '_blank'); reservations++; return tab } })
  panel.render()
  let tree = await panel.settle()
  const [primary] = nodes(tree, 'section')
  assert.match(text(primary), /同一中继和同一个 Google 账号.*发现其他设备/)
  assert.equal(input(primary, hubLabel), undefined)
  assert.equal(google(primary).props.disabled, false)
  assert.deepEqual(panel.requests.map((req) => req.path), ['/web/status'])
  const click = google(primary).props.onClick
  click()
  click()
  assert.equal(reservations, 1)
  assert.equal(panel.requests.filter((req) => req.path === googleStart).length, 1)
  assert.equal(google(panel.render()).props.disabled, true)
  opening.resolve({ authorization_url: googleAuthorization })
  tree = await panel.settle()
  assert.deepEqual(destinations, [googleAuthorization])
  assert.match(text(tree), /在新标签页完成 Google 登录/)
  assert.doesNotMatch(text(tree), /已通过 Google 登录|opaque-oauth-state/)
  current = status({ login_provider: 'google' })
  panel.focus()
  tree = await panel.settle()
  assert.match(text(tree), /已通过 Google 登录/)
  assert.equal(google(tree), undefined)
  assert.equal(nodes(tree, 'li').length, 1)
  assert.deepEqual(panel.requests.map((req) => req.path), ['/web/status', googleStart, '/web/status', '/web/status'])
  panel.unmount()
  assert.equal(tab.closed, false)
})

test('binds a joined legacy identity to Google only at its configured Hub', async (t) => {
  let current = signedOut({ hub_url: '' })
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return current
    assert.equal(path, googleStart)
    assert.deepEqual(body, { hub_url: 'https://fixed-hub.example/' })
    return { authorization_url: googleAuthorization }
  })
  panel.render()
  change(await panel.settle(), hubLabel, 'https://unjoined-draft.example/')
  current = status({ hub_url: 'https://fixed-hub.example/', login_provider: 'legacy', remote_control_enabled: true, control_ready: true })
  panel.tick()
  const tree = await panel.settle()
  assert.equal(input(tree, hubLabel), undefined)
  assert.match(text(tree), /将现有 Web 身份关联到 Google 账号/)
  assert.doesNotMatch(text(tree), /已通过 Google 登录|已配对|Web 邀请码|本机 DSH Web HTTPS 地址/)
  assert.equal(nodes(tree, 'li').length, 0)
  assert.equal(control(tree), undefined)
  google(tree).props.onClick()
  await panel.settle()
  assert.deepEqual(panel.requests.filter((req) => req.init.method === 'POST').map((req) => req.path), [googleStart])
})

test('blocked Google popup offers a validated isolated link and removes it on Hub edit or sign-in', async (t) => {
  let current = signedOut({ hub_url: '' })
  const panel = mount(t, ({ path }) => path === '/web/status' ? current : { authorization_url: googleAuthorization })
  panel.render()
  change(await panel.settle(), hubLabel, 'https://hub.example/')
  google(panel.render()).props.onClick()
  let tree = await panel.settle()
  const [link] = nodes(tree, 'a')
  assert.equal(link.props.href, googleAuthorization)
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noopener noreferrer')
  change(tree, hubLabel, 'https://different.example')
  tree = panel.render()
  assert.equal(nodes(tree, 'a').length, 0)
  change(tree, hubLabel, 'https://hub.example/')
  tree = panel.render()
  assert.equal(nodes(tree, 'a').length, 0)
  google(tree).props.onClick()
  assert.equal(nodes(await panel.settle(), 'a').length, 1)
  current = status()
  panel.tick()
  tree = await panel.settle()
  assert.match(text(tree), /已通过 Google 登录/)
  assert.equal(nodes(tree, 'a').length, 0)
})

test('Google sign-in fails closed on noncanonical authorization URLs', async (t) => {
  for (const invalid of [
    undefined, { url: googleAuthorization }, googleEndpoint, googleEndpoint + '?', googleAuthorization + '#', googleAuthorization + '#fragment',
    googleAuthorization.replace('https:', 'http:'), googleAuthorization.replace('accounts.google.com', 'accounts.google.com.attacker.example'),
    googleAuthorization.replace('accounts.google.com', 'accounts.google.com@attacker.example'),
    googleAuthorization.replace('accounts.google.com', 'user:password@accounts.google.com'),
    googleAuthorization.replace('accounts.google.com', '@accounts.google.com'),
    googleAuthorization.replace('accounts.google.com', 'accounts.google.com:443'),
    googleAuthorization.replace('accounts.google.com', 'accounts.google.com:444'),
    googleAuthorization.replace('/v2/auth', '/v2/a/../auth'), googleAuthorization.replace('/v2/auth', '/v2/%61uth'),
    googleAuthorization.replace('/v2/auth', '/v2/auth/'), googleAuthorization + '\\invalid', ' ' + googleAuthorization,
  ]) {
    const { tab, destinations } = popup()
    const panel = mount(t, ({ path }) => path === '/web/status' ? signedOut() : { authorization_url: invalid }, { open: () => tab })
    panel.render()
    google(await panel.settle()).props.onClick()
    const tree = await panel.settle()
    assert.match(text(tree), /Google 登录链接无效/)
    assert.equal(tab.closed, true, String(invalid))
    assert.deepEqual(destinations, [])
    assert.equal(nodes(tree, 'a').length, 0)
    panel.unmount()
  }
  const panel = mount(t, ({ path }) => path === '/web/status' ? signedOut() : { authorization_url: entry })
  panel.render()
  google(await panel.settle()).props.onClick()
  assert.equal(nodes(await panel.settle(), 'a').length, 0)
})

test('accepts a Hub root only when unconfigured and offers no Web invite fallback', async (t) => {
  let reservations = 0
  const { tab } = popup()
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return signedOut({ hub_url: '' })
    assert.equal(path, googleStart)
    assert.deepEqual(body, { hub_url: 'http://127.0.0.1:3081/' })
    return { http: 404, data: { error: { code: 'not_found' } } }
  }, { open: () => { reservations++; return tab } })
  panel.render()
  let tree = await panel.settle()
  assert.equal(input(tree, hubLabel).props.value, '')
  assert.equal(google(tree).props.disabled, true)
  for (const invalid of ['http://public-hub.example', 'https://hub.example/prefix', 'https://hub.example/?token=unsafe']) {
    change(tree, hubLabel, invalid)
    tree = panel.render()
    assert.equal(google(tree).props.disabled, true)
    google(tree).props.onClick()
  }
  assert.equal(reservations, 0)
  change(tree, hubLabel, 'http://127.0.0.1:3081/')
  google(panel.render()).props.onClick()
  tree = await panel.settle()
  assert.match(text(tree), /中继不支持 Google 登录或尚未配置.*联系中继管理员/)
  assert.equal(tab.closed, true)
  assert.doesNotMatch(text(tree), /Web 邀请码|启用本机 Web 身份|本机 DSH Web HTTPS 地址/)
  assert.equal(nodes(tree, 'details').length, 0)
  assert.deepEqual(panel.requests.map((req) => req.path), ['/web/status', googleStart, '/web/status'])
})

test('maps Google errors without reflecting server text', async (t) => {
  for (const [http, code, copy] of [
    [503, 'google_not_configured', /尚未配置/], [400, 'invalid_return_origin', /无法接收 Google 登录回调/],
    [409, 'google_account_mismatch', /已关联其他 Google 账号/], [409, 'web_hub_mismatch', /现有 Web 身份所在的中继/],
    [429, 'google_flow_limit', /Google 登录请求过多/],
    [502, 'unexpected-server-secret', /操作失败（HTTP 502）/],
  ]) {
    const panel = mount(t, ({ path }) => path === '/web/status' ? signedOut() : { http, data: { error: { code, message: 'server-secret' } } })
    panel.render()
    google(await panel.settle()).props.onClick()
    const tree = await panel.settle()
    assert.match(text(nodes(tree, 'p').find((p) => p.props.role === 'alert')), copy)
    assert.doesNotMatch(text(tree), /server-secret/)
    assert.equal(nodes(tree, 'a').length, 0)
    assert.equal(google(tree).props.disabled, false)
    panel.unmount()
  }
})

test('defaults control to off and confirms native owner access only when enabling', async (t) => {
  let current = status()
  let approved = false, confirmations = 0
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return current
    assert.equal(path, '/web/control')
    assert.deepEqual(body, { enabled: !current.remote_control_enabled })
    current = status({ remote_control_enabled: body.enabled })
    return { ok: true }
  }, { confirm(message) {
    confirmations++
    assert.match(message, /同一 Google 账号.*所有者.*DSH 终端.*不是屏幕共享/)
    return approved
  } })
  panel.render()
  let tree = await panel.settle()
  assert.equal(control(tree).props.role, 'switch')
  assert.equal(control(tree).props.checked, false)
  assert.equal(control(tree).props.disabled, false)
  assert.match(text(tree), /远程控制已关闭/)
  assert.doesNotMatch(text(tree), /Web 邀请码|本机 DSH Web HTTPS 地址|解除配对/)
  assert.deepEqual(panel.requests.map((req) => req.path), ['/web/status'])
  toggle(tree, true)
  assert.equal(confirmations, 1)
  assert.equal(panel.requests.length, 1)
  assert.equal(control(panel.render()).props.checked, false)

  approved = true
  toggle(tree, true)
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, true)
  assert.match(text(tree), /已允许远程控制，等待中继就绪/)
  current = { ...current, control_error: 'relay_certificate_error' }
  panel.tick()
  tree = await panel.settle()
  assert.match(text(tree), /无法验证中继的安全凭证/)
  assert.equal(open(tree).props.disabled, false, 'local host readiness does not affect outgoing opens')
  current = { ...current, control_ready: true, control_error: null }
  panel.tick()
  tree = await panel.settle()
  assert.match(text(tree), /远程控制已就绪/)
  toggle(tree, false)
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, false)
  assert.match(text(tree), /其他设备无法再通过中继访问本机/)
  assert.equal(confirmations, 2, 'turning off must not prompt again')
  assert.deepEqual(panel.requests.filter((req) => req.path === '/web/control').map((req) => req.body), [{ enabled: true }, { enabled: false }])
})

test('requires separate plaintext and owner consent for server browser access', async (t) => {
  let current = signedOut()
  let approved = false
  const confirmations = []
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return current
    if (path === portalControl) current = { ...current, portal_access_enabled: body.enabled }
    else {
      assert.equal(path, '/web/control')
      current = status({ remote_control_enabled: body.enabled })
    }
    return { ok: true }
  }, { confirm(message) { confirmations.push(message); return approved } })
  panel.render()
  assert.equal(portal(await panel.settle()), undefined)
  current = status()
  panel.focus()
  let tree = await panel.settle()
  assert.equal(portal(tree).props.role, 'switch')
  assert.equal(portal(tree).props.checked, false, 'old status without portal_access_enabled defaults to off')
  assert.equal(portal(tree).props.disabled, true)
  togglePortal(tree, true)
  assert.equal(confirmations.length, 0)

  approved = true
  toggle(tree, true)
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, true)
  assert.equal(portal(tree).props.checked, false)
  assert.equal(portal(tree).props.disabled, false)
  approved = false
  togglePortal(tree, true)
  assert.match(confirmations[0], /同一 Google 账号.*所有者/)
  assert.match(confirmations[1], /中继（Hub）和终止 TLS 的服务器.*整个中继租约期间.*明文 DSH 内容.*DSH 所有者/)
  assert.equal(panel.requests.some(({ path }) => path === portalControl), false)
  approved = true
  togglePortal(tree, true)
  tree = await panel.settle()
  assert.equal(portal(tree).props.checked, true)
  assert.deepEqual(panel.requests.find(({ path }) => path === portalControl).body, { enabled: true })

  toggle(tree, false)
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, false)
  assert.equal(portal(tree).props.checked, false)
  assert.equal(portal(tree).props.disabled, true)
  assert.equal(confirmations.length, 3, 'turning off must not prompt again')
})

test('can turn off portal access locally during a Hub outage and stale refresh', async (t) => {
  const stale = deferred()
  let current = status({ remote_control_enabled: true, portal_access_enabled: true, web_error: 'relay_unavailable' })
  let reads = 0
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return ++reads === 2 ? stale.promise : current
    assert.equal(path, portalControl)
    assert.deepEqual(body, { enabled: false })
    current = { ...current, portal_access_enabled: false }
    return { ok: true }
  }, { confirm() { assert.fail('revocation never requires confirmation') } })
  panel.render()
  let tree = await panel.settle()
  assert.equal(portal(tree).props.checked, true)
  assert.equal(portal(tree).props.disabled, false)
  panel.focus()
  const obsolete = panel.requests.at(-1)
  togglePortal(panel.render(), false)
  assert.equal(obsolete.init.signal.aborted, true)
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, true)
  assert.equal(portal(tree).props.checked, false)
  assert.equal(portal(tree).props.disabled, true)
  stale.resolve(status({ remote_control_enabled: true, portal_access_enabled: true, control_ready: true }))
  assert.equal(portal(await panel.settle()).props.checked, false)
})

test('can revoke control despite an unreachable Hub and prevents stale polling from restoring the switch', async (t) => {
  const stale = deferred()
  let current = status({ remote_control_enabled: true, web_error: 'relay_unavailable' })
  let reads = 0
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return ++reads === 2 ? stale.promise : current
    assert.equal(path, '/web/control')
    assert.deepEqual(body, { enabled: false })
    current = status({ web_error: 'relay_unavailable' })
    return { ok: true }
  }, { confirm() { assert.fail('revocation never requires confirmation') } })
  panel.render()
  let tree = await panel.settle()
  assert.match(text(tree), /无法连接远程控制中继/)
  assert.equal(control(tree).props.checked, true)
  assert.equal(control(tree).props.disabled, false)
  panel.focus()
  const obsolete = panel.requests.at(-1)
  toggle(panel.render(), false)
  assert.equal(obsolete.init.signal.aborted, true)
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, false)
  assert.equal(control(tree).props.disabled, true, 'cannot enable while Hub status reports an error')
  stale.resolve(status({ remote_control_enabled: true, control_ready: true }))
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, false)
  assert.doesNotMatch(text(tree), /远程控制已就绪/)
})

test('still attempts local revocation when refresh fails after a valid Google status', async (t) => {
  let reads = 0
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return ++reads === 1
      ? status({ remote_control_enabled: true, control_ready: true })
      : { http: 502, data: { error: { code: 'hub_unavailable' } } }
    assert.equal(path, '/web/control')
    assert.deepEqual(body, { enabled: false })
    return { ok: true }
  })
  panel.render()
  await panel.settle()
  panel.tick()
  let tree = await panel.settle()
  assert.equal(control(tree).props.disabled, false)
  toggle(tree, false)
  tree = await panel.settle()
  assert.equal(control(tree).props.checked, false)
  assert.match(text(tree), /已关闭远程控制/)
})

test('keeps the persisted toggle state after a rejected change', async (t) => {
  const panel = mount(t, ({ path }) => path === '/web/status' ? status() : {
    http: 403, data: { error: { code: 'local_control_only', message: 'hidden-email@example.test' } },
  })
  panel.render()
  toggle(await panel.settle(), true)
  const tree = await panel.settle()
  assert.equal(control(tree).props.checked, false)
  assert.match(text(tree), /在本机直接打开 DSH/)
  assert.doesNotMatch(text(tree), /hidden-email/)
})

test('explains unavailable targets and relay failures without echoing server data', async (t) => {
  for (const [code, copy] of [
    ['target_unavailable', /对方设备当前不可访问/],
    ['device_not_found', /找不到此设备/],
    ['web_not_enabled', /对方设备未允许远程控制/],
    ['relay_not_ready', /中继尚未就绪/],
    ['relay_unavailable', /无法连接远程控制中继/],
    ['relay_certificate_error', /无法验证中继的安全凭证/],
    ['google_binding_required', /请先使用 Google 登录/],
    ['hidden-error-code', /操作失败（HTTP 409）/],
  ]) {
    const { tab, destinations } = popup()
    const panel = mount(t, ({ path }) => path === '/web/status' ? status() : {
      http: 409, data: { error: { code, message: entry } },
    }, { open: () => tab })
    panel.render()
    open(await panel.settle()).props.onClick()
    const tree = await panel.settle()
    assert.match(text(tree), copy)
    assert.doesNotMatch(JSON.stringify(tree), /mock-relay-secret|hidden-error-code/)
    assert.deepEqual(destinations, [])
    assert.equal(tab.closed, true)
    panel.unmount()
  }
})

test('shows no pairing codes or legacy enrollment controls', async (t) => {
  const panel = mount(t, () => status({ devices: [] }))
  panel.render()
  const tree = await panel.settle()
  assert.doesNotMatch(text(tree), /配对码|邀请码|会话同步配对/)
  assert.equal(nodes(tree, 'details').length, 0)
  assert.ok(panel.requests.every((req) => req.path === '/web/status'))
})
