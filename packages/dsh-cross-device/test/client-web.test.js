import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const prefix = '/api/cross-device'
const localOrigin = 'https://local.example'
const entry = 'https://remote.example/dsh-bridge-enter'
const googleStart = '/web/google/start'
const googleEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth'
const googleAuthorization = googleEndpoint + '?' + new URLSearchParams({
  client_id: 'bridge.apps.googleusercontent.com', response_type: 'code', scope: 'openid email profile',
  redirect_uri: 'https://hub.example/api/v1/web/google/callback', state: 'opaque-oauth-state'.padEnd(43, 's'),
  nonce: 'n'.repeat(43), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256',
})
const invite = '0123456789abcdefABCDEF_-'
const peer = { device_id: 'peer', device_name: '远程设备', status: 'online', web_enabled: true }
const status = (overrides = {}) => ({ hub_url: 'https://hub.example/', device_name: '本机设备', joined: true, can_enroll: false, web_url: null, devices: [peer], ...overrides })
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
      assert.match(url, /^\/api\/cross-device\/(?:web\/|config$|pairing\/)/)
      assert.equal(init.headers['x-cross-device'], '1')
      assert.equal(init.mode, 'same-origin')
      assert.equal(init.credentials, 'same-origin')
      assert.equal(init.redirect, 'error')
      assert.equal(init.cache, 'no-store')
      assert.equal(init.referrerPolicy, path === googleStart ? 'origin' : undefined)
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
const detailsWith = (tree, label) => nodes(tree, 'details').find((node) => text(nodes(node, 'summary')[0]) === label)
const input = (tree, label) => nodes(tree, 'label').find((node) => node.children[0] === label)?.children.find((node) => node?.type === 'input')
const change = (tree, label, value) => input(tree, label).props.onChange({ target: { value } })
function submit(tree, label) {
  const form = nodes(tree, 'form').find((node) => button(node, label))
  assert.equal(button(form, label).props.disabled, false)
  form.props.onSubmit({ preventDefault() {} })
}
function popup() {
  const destinations = []
  const tab = {
    opener: {}, closed: false, close() { this.closed = true },
    location: { replace(href) { assert.equal(tab.opener, null); destinations.push(href) } },
  }
  return { tab, destinations }
}

test('lists only Web peers and handles polling, focus, and retry', async (t) => {
  const initial = deferred()
  let next = initial.promise
  const panel = mount(t, () => next)
  assert.match(text(panel.render()), /正在加载 Web 设备/)
  initial.resolve(status({ devices: [
    { ...peer, sessions: [{ title: '不显示的会话' }] },
    { ...peer, device_id: 'off', device_name: '离线设备', status: 'offline' },
    { ...peer, device_id: 'off-web', device_name: '未开设备', web_enabled: false },
    { ...peer, device_id: 'self', device_name: '不显示的自己', is_self: true },
    { ...peer, device_id: 'unpaired', device_name: '不显示的未配对', paired: false },
  ] }))
  let tree = await panel.settle()
  assert.doesNotMatch(text(tree), /不显示/)
  assert.deepEqual(nodes(tree, 'li').map((row) => text(row).split('打开 Web')[0]), ['远程设备在线', '离线设备离线', '未开设备在线未开放 Web'])
  assert.deepEqual(nodes(tree, 'li').map((row) => button(row, '打开 Web').props.disabled), [false, true, true])
  next = { http: 502, data: { error: { code: 'hub_error' } } }
  panel.tick()
  panel.focus() // no duplicate while the poll is in flight
  tree = await panel.settle()
  assert.equal(panel.requests.length, 2)
  assert.match(text(tree), /读取 Web 设备失败/)
  assert.equal(nodes(tree, 'li').length, 0)
  next = status({ devices: [], web_error: 'hub_error' })
  button(tree, '重试').props.onClick()
  tree = await panel.settle()
  assert.match(text(tree), /读取 Web 设备失败/)
  next = status({ joined: false }) // ignore even unexpected peer data when not joined
  panel.focus()
  tree = await panel.settle()
  assert.match(text(tree), /暂无已配对的 Web 设备/)
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
    'http://remote.example/dsh-bridge-enter', localOrigin + '/dsh-bridge-enter',
    'https://dev.localhost./dsh-bridge-enter', 'https://2130706433/dsh-bridge-enter', 'https://[::1]/dsh-bridge-enter',
    'https://user:pass@remote.example/dsh-bridge-enter', entry + '?', entry + '#token', entry + '/',
    'https://remote.example/dsh-bridge-elsewhere', 'https://remote.example/a/../dsh-bridge-enter',
    'https://remote.example/%2e/dsh-bridge-enter', 'https://remote.example/%64sh-bridge-enter',
  ]) {
    const { tab, destinations } = popup()
    const panel = mount(t, ({ path }) => path === '/web/status' ? status() : { entry_url: invalid }, { open: () => tab })
    panel.render()
    open(await panel.settle()).props.onClick()
    assert.match(text(await panel.settle()), /远端入口无效/)
    assert.equal(tab.closed, true, invalid)
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

test('offers an explicit noopener fallback when popups are blocked', async (t) => {
  const panel = mount(t, ({ path }) => path === '/web/status' ? status() : { entry_url: entry })
  panel.render()
  open(await panel.settle()).props.onClick()
  const [link] = nodes(await panel.settle(), 'a')
  assert.equal(link.props.href, entry)
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noopener noreferrer')
})

test('Google-first pairing reserves an isolated tab on click and confirms via local status', async (t) => {
  let current = status({ joined: false, login_provider: null, devices: [] })
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
  assert.match(text(primary), /同一中继和同一个 Google 账号.*自动配对，无需邀请码/)
  assert.equal(input(primary, 'Web 配对中继地址').props.value, current.hub_url)
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

test('links a joined Web identity only at its fixed Hub', async (t) => {
  let current = status({ joined: false, hub_url: '', devices: [] })
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return current
    assert.equal(path, googleStart)
    assert.deepEqual(body, { hub_url: 'https://fixed-hub.example/' })
    return { authorization_url: googleAuthorization }
  })
  panel.render()
  change(await panel.settle(), 'Web 配对中继地址', 'https://unjoined-draft.example/')
  current = status({ hub_url: 'https://fixed-hub.example/', login_provider: null })
  panel.tick()
  const tree = await panel.settle()
  assert.equal(input(tree, 'Web 配对中继地址'), undefined)
  assert.ok(text(tree).includes('中继地址（固定）：https://fixed-hub.example/'))
  assert.match(text(tree), /关联到现有 Web 身份，保留原有配对/)
  google(tree).props.onClick()
  await panel.settle()
  assert.deepEqual(panel.requests.filter((req) => req.init.method === 'POST').map((req) => req.path), [googleStart])
})

test('blocked popup offers only a validated, isolated link and removes it on Hub edit or sign-in', async (t) => {
  let current = status({ joined: false, login_provider: null, devices: [] })
  const panel = mount(t, ({ path }) => path === '/web/status' ? current : { authorization_url: googleAuthorization })
  panel.render()
  google(await panel.settle()).props.onClick()
  let tree = await panel.settle()
  const [link] = nodes(tree, 'a')
  assert.equal(link.props.href, googleAuthorization)
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noopener noreferrer')
  change(tree, 'Web 配对中继地址', 'https://different.example')
  tree = panel.render()
  assert.equal(nodes(tree, 'a').length, 0)
  change(tree, 'Web 配对中继地址', current.hub_url)
  tree = panel.render()
  assert.equal(nodes(tree, 'a').length, 0)
  google(tree).props.onClick()
  assert.equal(nodes(await panel.settle(), 'a').length, 1)
  current = status({ login_provider: 'google' })
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
    const panel = mount(t, ({ path }) => path === '/web/status' ? status() : { authorization_url: invalid }, { open: () => tab })
    panel.render()
    google(await panel.settle()).props.onClick()
    const tree = await panel.settle()
    assert.match(text(tree), /Google 登录链接无效/)
    assert.equal(tab.closed, true, String(invalid))
    assert.deepEqual(destinations, [])
    assert.equal(nodes(tree, 'a').length, 0)
    panel.unmount()
  }
  const panel = mount(t, ({ path }) => path === '/web/status' ? status() : { authorization_url: entry })
  panel.render()
  google(await panel.settle()).props.onClick()
  assert.equal(nodes(await panel.settle(), 'a').length, 0)
})

test('requires a usable Hub for Google and explains an older Hub without disabling invitations', async (t) => {
  let reservations = 0
  const { tab } = popup()
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return status({ joined: false, hub_url: '', devices: [] })
    assert.equal(path, googleStart)
    assert.deepEqual(body, { hub_url: 'http://127.0.0.1:3081/' })
    return { http: 404, data: { error: { code: 'not_found' } } }
  }, { open: () => { reservations++; return tab } })
  panel.render()
  let tree = await panel.settle()
  assert.equal(input(tree, 'Web 配对中继地址').props.value, '')
  assert.equal(google(tree).props.disabled, true)
  for (const invalid of ['http://public-hub.example', 'https://hub.example/prefix', 'https://hub.example/?token=unsafe']) {
    change(tree, 'Web 配对中继地址', invalid)
    tree = panel.render()
    assert.equal(google(tree).props.disabled, true)
    google(tree).props.onClick()
  }
  assert.equal(reservations, 0)
  change(tree, 'Web 配对中继地址', 'http://127.0.0.1:3081/')
  google(panel.render()).props.onClick()
  tree = await panel.settle()
  assert.match(text(tree), /中继不支持 Google 登录或尚未配置.*使用 Web 邀请码配对/)
  assert.equal(tab.closed, true)
  const fallback = detailsWith(tree, 'Web 邀请码配对（备用）')
  assert.notEqual(fallback.props.open, true)
  change(fallback, '24 位 Web 邀请码', invite)
  assert.equal(button(panel.render(), '使用 Web 邀请码配对').props.disabled, false)
})

test('maps Google errors without reflecting server text', async (t) => {
  for (const [http, code, copy] of [
    [503, 'google_not_configured', /尚未配置/], [400, 'invalid_return_origin', /无法接收 Google 登录回调/],
    [409, 'google_account_mismatch', /已关联其他 Google 账号/], [409, 'web_hub_mismatch', /现有 Web 身份所在的中继/],
    [429, 'google_flow_limit', /Google 登录请求过多/],
    [502, 'unexpected-server-secret', /操作失败（HTTP 502）/],
  ]) {
    const panel = mount(t, ({ path }) => path === '/web/status' ? status() : { http, data: { error: { code, message: 'server-secret' } } })
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

test('pairs by invitation and changes presence only after explicit opt-in', async (t) => {
  let current = status({ joined: false, can_enroll: true, hub_url: '', advertised_web_url: localOrigin })
  const panel = mount(t, ({ path, body }) => {
    switch (path) {
      case '/web/status': return current
      case '/web/enroll': return { http: 403, data: { error: { code: 'forbidden' } } }
      case '/web/pairing/claim': current = { ...current, joined: true, can_enroll: false, hub_url: body.hub_url }; return { ok: true }
      case '/web/pairing/code': return { code: invite, expires_at: '2099-01-01T00:00:00Z' }
      case '/web/presence': current = { ...current, web_url: body.web_url }; return { ok: true }
    }
  })
  panel.render()
  let tree = await panel.settle()
  button(tree, '启用本机 Web 身份').props.onClick()
  tree = await panel.settle()
  assert.match(text(tree), /403/)
  assert.deepEqual(panel.requests.find((req) => req.path === '/web/enroll').body, {})
  change(tree, 'Web 配对中继地址', 'https://other-hub.example/')
  change(tree, '24 位 Web 邀请码', '123456')
  tree = panel.render()
  assert.equal(button(tree, '使用 Web 邀请码配对').props.disabled, true)
  change(tree, '24 位 Web 邀请码', ' ' + invite + ' ')
  submit(panel.render(), '使用 Web 邀请码配对')
  tree = await panel.settle()
  assert.equal(input(tree, 'Web 配对中继地址'), undefined)
  change(tree, '24 位 Web 邀请码', invite)
  submit(panel.render(), '使用 Web 邀请码配对')
  tree = await panel.settle()
  assert.deepEqual(panel.requests.filter((req) => req.path === '/web/pairing/claim').map((req) => req.body), [
    { hub_url: 'https://other-hub.example/', code: invite }, { hub_url: 'https://other-hub.example/', code: invite },
  ])
  button(tree, '生成 Web 邀请码').props.onClick()
  tree = await panel.settle()
  assert.match(text(tree), /有效至/)
  assert.equal(input(tree, '本机 DSH Web HTTPS 地址').props.value, localOrigin)
  assert.equal(panel.requests.some((req) => req.path === '/web/presence'), false)
  change(tree, '本机 DSH Web HTTPS 地址', localOrigin + '?token=unsafe')
  assert.equal(button(panel.render(), '开放 Web').props.disabled, true)
  change(tree, '本机 DSH Web HTTPS 地址', 'https://different.example')
  assert.equal(button(panel.render(), '开放 Web').props.disabled, true)
  change(tree, '本机 DSH Web HTTPS 地址', localOrigin + '/')
  submit(panel.render(), '开放 Web')
  tree = await panel.settle()
  assert.match(text(tree), /已开放 Web：https:\/\/local\.example/)
  button(tree, '关闭 Web').props.onClick()
  await panel.settle()
  assert.deepEqual(panel.requests.filter((req) => req.path === '/web/presence').map((req) => req.body), [{ web_url: localOrigin }, { web_url: null }])
})

test('confirms unlink and ignores an obsolete pre-mutation status reply', async (t) => {
  let confirm = false, reads = 0, unlinked = false
  const stale = deferred()
  const panel = mount(t, ({ path, body }) => {
    if (path === '/web/status') return ++reads === 2 ? stale.promise : status({ devices: unlinked ? [] : [peer] })
    assert.equal(path, '/web/unpair')
    assert.deepEqual(body, { device_id: 'peer' })
    unlinked = true
    return { ok: true }
  }, { confirm(message) { assert.match(message, /解除与「远程设备」/); return confirm } })
  panel.render()
  const unlink = button(await panel.settle(), '解除配对').props.onClick
  unlink()
  assert.equal(unlinked, false)
  panel.focus() // a read can start before React commits the next render
  const obsolete = panel.requests.at(-1)
  confirm = true
  unlink()
  assert.equal(obsolete.init.signal.aborted, true)
  assert.match(text(await panel.settle()), /暂无已配对的 Web 设备/)
  stale.resolve(status())
  assert.equal(nodes(await panel.settle(), 'li').length, 0)
})

test('keeps six-digit iOS pairing in its own collapsible view', async (t) => {
  let configured = false
  const panel = mount(t, ({ path }) => {
    switch (path) {
      case '/web/status': return status({ devices: [] })
      case '/config': return { enabled: configured, hub_url: 'https://sync.example', token_configured: configured }
      case '/pairing/claim': configured = true; return { ok: true }
      case '/pairing/code': return { code: '123456' }
    }
  })
  panel.render()
  let tree = await panel.settle()
  assert.equal(panel.requests.some((req) => req.path === '/config'), false)
  const details = detailsWith(tree, '会话同步配对（iOS）')
  assert.equal(input(details, '24 位 Web 邀请码'), undefined)
  details.props.onToggle({ currentTarget: { open: true } })
  tree = await panel.settle()
  change(tree, '会话同步中继地址', 'https://sync.example')
  change(tree, '6 位会话同步配对码', '12a3456')
  submit(panel.render(), '配对会话同步')
  tree = await panel.settle()
  assert.deepEqual(panel.requests.find((req) => req.path === '/pairing/claim').body, { hub_url: 'https://sync.example', code: '123456' })
  button(tree, '生成 6 位配对码').props.onClick()
  tree = await panel.settle()
  assert.equal(nodes(tree, 'code').some((node) => text(node) === '123456'), true)
  assert.equal(nodes(tree, 'li').length, 0)
})
