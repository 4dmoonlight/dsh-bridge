/**
 * 客户端半：侧边栏图标打开 main 插槽里的「跨设备」Web 登录与配对页。
 * 本文件不经构建；使用宿主提供的 React，不使用 JSX。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cross-device',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef, useCallback } = require('react')

    const API = '/api/cross-device'
    const ENTRY_PATH = '/dsh-bridge-enter'
    const GOOGLE_START_PATH = '/web/google/start'
    const GOOGLE_ORIGIN = 'https://accounts.google.com'
    const GOOGLE_AUTH_PATH = '/o/oauth2/v2/auth'
    const STATUS_PATHS = { web: '/web/status', sync: '/config' }
    const WEB_CODE = /^[A-Za-z0-9_-]{24}$/
    const SYNC_CODE = /^[0-9]{6}$/
    const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'localhost6', 'localhost6.localdomain6', 'ip6-localhost', 'ip6-loopback'])
    const INITIAL = { value: null, loading: true, error: '' }

    const S = {
      wrap: { height: '100%', boxSizing: 'border-box', overflow: 'auto', padding: '10px 12px', fontSize: 13 },
      page: { maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
      heading: { margin: 0, fontSize: 13, fontWeight: 600 },
      btn: { border: '1px solid var(--dsh-border, #d0d0d0)', borderRadius: 6, background: 'transparent', color: 'inherit', padding: '4px 8px', fontSize: 12 },
      primary: { background: '#1d4ed8', color: '#fff', borderColor: 'transparent', padding: '6px 12px', fontSize: 13, fontWeight: 600 },
      section: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--dsh-border, #d0d0d0)', paddingTop: 8 },
      list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 },
      device: { border: '1px solid var(--dsh-border, #d0d0d0)', borderRadius: 6, padding: '6px 8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
      dot: (online) => ({ width: 7, height: 7, borderRadius: '50%', background: online ? '#22c55e' : '#9ca3af', flex: '0 0 auto' }),
      name: { fontWeight: 600, overflowWrap: 'anywhere' },
      meta: { margin: 0, fontSize: 12, opacity: 0.8, overflowWrap: 'anywhere' },
      error: { margin: 0, fontSize: 12, color: 'var(--dsh-text-danger, #dc2626)' },
      tag: { fontSize: 11, padding: '0 4px', borderRadius: 4, border: '1px solid currentColor', opacity: 0.8 },
      form: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
      field: { display: 'grid', gap: 2, width: '100%', maxWidth: 380, fontSize: 12 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 13,
        borderRadius: 6, border: '1px solid var(--dsh-border, #d0d0d0)', background: 'transparent', color: 'inherit',
      },
    }

    const ERRORS = {
      invalid_response: '本机 DSH 返回了无效的响应。',
      invalid_entry_url: '远端入口无效，已取消打开。',
      web_url_same_device: '入口指向当前 DSH，不会作为远端打开。',
      web_url_not_advertised: '地址与本机 DSH 声明的 HTTPS 地址不一致。请检查 DSH 的 --public-url 和 --trusted-host。',
      instance_token_required: '本机需要配置有权限的中继实例凭据才能启用 Web。',
      unauthorized: '凭据无效或已过期，请检查本机 DSH 配置。',
      hub_error: '无法连接中继，请检查中继连接后重试。',
      hub_unavailable: '无法连接中继，请检查中继连接后重试。',
      invalid_hub_response: '中继返回了无效的响应。',
      web_busy: '本机正在处理另一项 Web 操作，请稍后重试。',
      web_hub_mismatch: '请使用现有 Web 身份所在的中继；配对的设备也必须使用同一中继。',
      google_not_configured: '此中继不支持 Google 登录或尚未配置。请让中继管理员升级并配置 Google 登录，或使用 Web 邀请码配对。',
      invalid_return_origin: '当前 DSH Web 地址无法接收 Google 登录回调。请从中继允许的 DSH Web 地址打开此页后重试。',
      google_account_mismatch: '此 Web 身份已关联其他 Google 账号。请使用原账号登录。',
      google_flow_limit: '此中继的 Google 登录请求过多，请稍后重试。',
      invalid_google_authorization_url: '收到的 Google 登录链接无效，已取消打开。',
      self_claim: '不能使用本机生成的 Web 邀请码与自己配对。',
      popup_closed: '新标签页已关闭，请重新打开。',
      invalid_hub_url: '中继地址无效。',
      invalid_web_url: '请填写可信任的独立 HTTPS 根地址，不带路径、查询参数或令牌。',
      invalid_code: '配对码格式不正确。',
      pairing_code_invalid: '配对码无效、已使用或已过期。',
      rate_limited: '操作过于频繁，请稍后重试。',
      not_configured: '尚未配置本机会话同步。',
      web_not_joined: '本机尚未启用或配对 Web 身份。',
      not_paired: '这台设备未与本机配对。',
      device_offline: '对方设备已离线。',
      web_not_enabled: '对方设备未开放 Web。',
    }

    function errorMessage(error) {
      if (Object.hasOwn(ERRORS, error?.message)) return ERRORS[error.message]
      if (error?.status === 403) return '本机 DSH 拒绝此操作（403），请检查本机配置和权限。'
      // Do not echo unrecognized server text that might include sensitive data.
      return Number.isInteger(error?.status)
        ? '操作失败（HTTP ' + error.status + '），请重试。'
        : '无法完成请求，请检查本机 DSH 和中继连接后重试。'
    }

    async function request(route, signal, payload) {
      const post = payload !== undefined
      const response = await fetch(API + route, {
        method: post ? 'POST' : 'GET',
        headers: post ? { 'x-cross-device': '1', 'content-type': 'application/json' } : { 'x-cross-device': '1' },
        body: post ? JSON.stringify(payload) : undefined,
        credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal,
        // Start must receive the real browser Origin even under a no-referrer document policy.
        ...(route === GOOGLE_START_PATH ? { referrerPolicy: 'origin' } : null),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        const code = data?.error?.code
        throw Object.assign(new Error(typeof code === 'string' ? code : 'http_' + response.status), { status: response.status })
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_response')
      return data
    }

    function requireOk(data) {
      if (data.ok !== true) throw new Error('invalid_response')
    }

    function parseWebUrl(value, path = '/') {
      if (typeof value !== 'string') return null
      // Check raw syntax before URL normalization (no encoded segments, dot segments,
      // query/fragment delimiters, backslashes, whitespace or URL credentials).
      const authority = value.match(/^https:\/\/[^/@%?#\\\s\x00-\x1f\x7f]+/i)
      if (!authority) return null
      const suffix = value.slice(authority[0].length)
      if (suffix !== path && !(path === '/' && suffix === '')) return null
      try {
        const url = new URL(value)
        const host = url.hostname.replace(/\.$/, '')
        // URL canonicalizes IPv4 aliases and IPv6 before the loopback check.
        const loopback = LOCAL_NAMES.has(host) || host.endsWith('.localhost') || /^(0|127)(\.\d+){3}$/.test(host) ||
          /^\[::(?:[0-9a-f]{1,4}|(?:ffff:)?(?:[0-9a-f]{1,2}|7f[0-9a-f]{2}):[0-9a-f]{1,4})?\]$/.test(host)
        const sameDevice = path === ENTRY_PATH && url.origin === window.location.origin
        return url.protocol === 'https:' && url.pathname === path && !loopback && !sameDevice ? url : null
      } catch {
        return null
      }
    }

    function hubAddress(value, webOnly = false) {
      const address = value.trim()
      if (!/^https?:\/\/[^/]/i.test(address) || /[@?#\\\s\x00-\x1f\x7f]/.test(address)) return ''
      try {
        const url = new URL(address)
        if (webOnly && url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return ''
        return url.hostname ? address : ''
      } catch {
        return ''
      }
    }

    function googleAuthorizationUrl(value) {
      // Require the literal endpoint before parsing (no alternate authorities,
      // URL normalization tricks or fragments). OAuth parameters are opaque here.
      if (typeof value !== 'string' || !value.startsWith(GOOGLE_ORIGIN + GOOGLE_AUTH_PATH + '?') || /[#\\\s\x00-\x1f\x7f]/.test(value)) return null
      try {
        const url = new URL(value)
        return url.origin === GOOGLE_ORIGIN && url.pathname === GOOGLE_AUTH_PATH &&
          !url.username && !url.password && !url.hash && url.search ? url : null
      } catch {
        return null
      }
    }

    function statusValue(scope, data) {
      if (scope === 'sync') return { configured: data.enabled === true && Boolean(data.hub_url) && data.token_configured === true }
      if (typeof data.joined !== 'boolean' || typeof data.can_enroll !== 'boolean' || !Array.isArray(data.devices)) {
        throw new Error('invalid_response')
      }
      // Keep only browser-facing fields. The Web route is authoritative for peers;
      // never fetch or merge the legacy session list.
      return {
        joined: data.joined,
        login_provider: data.joined && data.login_provider === 'google' ? 'google' : null,
        can_enroll: data.can_enroll,
        device_name: typeof data.device_name === 'string' ? data.device_name : '',
        hub_url: typeof data.hub_url === 'string' && hubAddress(data.hub_url, true) ? data.hub_url : '',
        web_url: typeof data.web_url === 'string' ? data.web_url : null,
        web_error: data.web_error ? errorMessage({ message: data.web_error }) : '',
        ...(Object.hasOwn(data, 'advertised_web_url') ? { advertised_web_url: data.advertised_web_url } : {}),
        devices: data.joined ? data.devices.filter((dev) => dev && !dev.is_self && dev.paired !== false &&
          typeof dev.device_id === 'string' && dev.device_id && (dev.status === 'online' || dev.status === 'offline') &&
          typeof dev.web_enabled === 'boolean').map(({ device_id, device_name, status, web_enabled }) => ({ device_id, device_name, status, web_enabled })) : [],
      }
    }

    function closeTab(tab) {
      try { if (tab && !tab.closed) tab.close() } catch { /* tab no longer accessible */ }
    }

    function reserveTab() {
      let tab
      try {
        // Must run during the trusted click. noopener here would lose the handle
        // needed to navigate/close the blank tab after the local request resolves.
        tab = window.open('about:blank', '_blank')
        if (!tab || tab.closed) return null
        tab.opener = null
        if (tab.opener === null) return tab
      } catch { /* fallback uses a fresh, explicit noopener link */ }
      closeTab(tab)
      return null
    }

    function cancelLoad(instance, scope) {
      const controller = instance.loads[scope]
      if (!controller) return false
      instance.loads[scope] = null
      controller.abort()
      return true
    }

    function usePanelRequests() {
      const [web, setWeb] = useState(INITIAL)
      const [sync, setSync] = useState(INITIAL)
      const [busy, setBusy] = useState(false)
      const [feedback, setFeedback] = useState(null)
      const panel = useRef(null)

      const refresh = useCallback(async (scope = 'web') => {
        const instance = panel.current
        if (!instance || instance.action || instance.loads[scope] || (scope === 'sync' && !instance.syncExpanded)) return
        const controller = new AbortController()
        instance.loads[scope] = controller
        const setView = scope === 'web' ? setWeb : setSync
        const current = () => panel.current === instance && instance.loads[scope] === controller
        setView((view) => ({ ...view, loading: true }))
        try {
          const result = await request(STATUS_PATHS[scope], controller.signal)
          if (current()) {
            const value = statusValue(scope, result)
            setView({ value, loading: false, error: '' })
            if (scope === 'web' && value.login_provider === 'google') {
              setFeedback((feedback) => feedback?.scope === 'google' ? null : feedback)
            }
          }
        } catch (error) {
          if (current()) setView((view) => ({ ...view, loading: false, error: errorMessage(error) }))
        } finally {
          if (current()) instance.loads[scope] = null
        }
      }, [])

      useEffect(() => {
        const instance = { loads: { web: null, sync: null }, action: null, syncExpanded: false }
        panel.current = instance
        void refresh()
        const timer = window.setInterval(() => void refresh(), 15000)
        const onFocus = () => { void refresh(); if (instance.syncExpanded) void refresh('sync') }
        window.addEventListener('focus', onFocus)
        return () => {
          panel.current = null
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          cancelLoad(instance, 'web')
          cancelLoad(instance, 'sync')
          instance.action?.controller.abort()
          closeTab(instance.action?.tab)
        }
      }, [refresh])

      function toggleSync(open) {
        const instance = panel.current
        if (!instance) return
        instance.syncExpanded = open
        if (open) void refresh('sync')
        else cancelLoad(instance, 'sync')
      }

      async function run(scope, perform) {
        const instance = panel.current
        if (!instance || instance.action) return
        const action = { controller: new AbortController(), tab: null }
        instance.action = action
        const current = () => panel.current === instance && instance.action === action
        // A GET started before a mutation may describe the old state even if it
        // arrives last. Cancel it and compare request identity before committing.
        if (cancelLoad(instance, 'web')) setWeb((view) => ({ ...view, loading: false }))
        if (cancelLoad(instance, 'sync')) setSync((view) => ({ ...view, loading: false }))
        setBusy(true)
        setFeedback(null)
        try {
          const finish = await perform(action)
          if (current()) setFeedback({ scope, ...finish() })
        } catch (error) {
          if (current()) setFeedback({ scope, text: errorMessage(error), error: true })
        } finally {
          closeTab(action.tab)
          if (current()) {
            instance.action = null
            setBusy(false)
            void refresh()
            if (instance.syncExpanded) void refresh('sync')
          }
        }
      }

      const updateWeb = (change) => setWeb((view) => ({ ...view, value: change(view.value) }))
      const clearFeedback = (scope) => setFeedback((feedback) => feedback?.scope === scope ? null : feedback)
      return { web, sync, busy, feedback, refresh, toggleSync, run, updateWeb, clearFeedback }
    }

    function button(text, props, primary = false) {
      const style = { ...S.btn, ...(primary ? S.primary : null), opacity: props.disabled ? 0.6 : 1, cursor: props.disabled ? 'not-allowed' : 'pointer' }
      return h('button', { type: 'button', style, ...props }, text)
    }

    function field(label, props) {
      return h('label', { style: S.field }, label, h('input', { style: S.input, autoComplete: 'off', ...props }))
    }

    function form(submit, ...children) {
      return h('form', { style: S.form, onSubmit: (event) => { event.preventDefault(); submit() } }, ...children)
    }

    function message(text, error = false) {
      return h('p', { role: error ? 'alert' : 'status', style: error ? S.error : S.meta }, text)
    }

    function invitation(data, pattern) {
      if (typeof data.code !== 'string' || !pattern.test(data.code)) throw new Error('invalid_response')
      const expires = typeof data.expires_at === 'string' || typeof data.expires_at === 'number' ? new Date(data.expires_at) : null
      return { code: data.code, expires: expires && Number.isFinite(expires.getTime()) ? expires : null }
    }

    function showInvitation(invite, label) {
      if (!invite) return null
      return h('div', { role: 'status', style: S.meta },
        label, '：', h('code', { style: { fontSize: 14, fontWeight: 600 } }, invite.code),
        invite.expires ? h('div', null, invite.expires.getTime() <= Date.now()
          ? '已过期，请重新生成。'
          : '有效至 ' + invite.expires.toLocaleString()) : null,
      )
    }

    function LegacyPairing({ connection }) {
      const { sync, busy, feedback, toggleSync, refresh, run } = connection
      const [hub, setHub] = useState('')
      const [code, setCode] = useState('')
      const [invite, setInvite] = useState(null)
      const configured = sync.value?.configured === true
      const address = hubAddress(hub)
      const disabled = busy || sync.loading || Boolean(sync.error)
      const notice = feedback?.scope === 'sync' ? feedback : null

      function generate() {
        if (disabled || !configured) return
        void run('sync', async ({ controller }) => {
          const result = await request('/pairing/code', controller.signal, {})
          return () => {
            setInvite(invitation(result, SYNC_CODE))
            return { text: '已生成 6 位会话同步配对码。' }
          }
        })
      }

      function claim() {
        if (disabled || configured || !address || !SYNC_CODE.test(code)) return
        void run('sync', async ({ controller }) => {
          const result = await request('/pairing/claim', controller.signal, { hub_url: address, code })
          return () => {
            requireOk(result)
            setCode('')
            return { text: '会话同步配对成功。此操作不会添加 Web 设备。' }
          }
        })
      }

      return h('details', { style: { ...S.section, display: 'block' }, onToggle: (event) => toggleSync(event.currentTarget.open) },
        h('summary', { style: { ...S.heading, cursor: 'pointer' } }, '会话同步配对（iOS）'),
        h('div', { style: { ...S.form, paddingTop: 6 } },
          h('p', { style: S.meta }, '仅用于原有的会话同步，使用 6 位配对码，不会添加 Web 设备。'),
          sync.loading && !sync.value ? message('正在检查会话同步配置…') : null,
          sync.error ? h('div', { style: S.row }, message('读取会话同步配置失败。' + sync.error, true),
            button('重试', { disabled: busy || sync.loading, onClick: () => void refresh('sync') })) : null,
          sync.value && !sync.error ? (configured
            ? button('生成 6 位配对码', { disabled, onClick: generate })
            : form(claim,
                field('会话同步中继地址', { type: 'url', value: hub, disabled: busy, placeholder: 'https://hub.example.com', onChange: (event) => setHub(event.target.value) }),
                field('6 位会话同步配对码', { inputMode: 'numeric', value: code, disabled: busy, maxLength: 6, onChange: (event) => setCode(event.target.value.replace(/[^0-9]/g, '')) }),
                button('配对会话同步', { type: 'submit', disabled: disabled || !address || !SYNC_CODE.test(code) }),
              )) : null,
          configured ? showInvitation(invite, '会话同步配对码') : null,
          notice ? message(notice.text, notice.error) : null,
        ),
      )
    }

    function deviceName(device) { return typeof device.device_name === 'string' && device.device_name ? device.device_name : '未命名设备' }
    function ready(device) { return device.status === 'online' && device.web_enabled === true }

    function DevicesPanel() {
      const connection = usePanelRequests()
      const { web, busy, feedback, refresh, run, updateWeb, clearFeedback } = connection
      const [hub, setHub] = useState(null)
      const [code, setCode] = useState('')
      const [invite, setInvite] = useState(null)
      const [webDraft, setWebDraft] = useState(null)
      const data = web.value
      const joined = data?.joined === true
      const statusError = web.error || data?.web_error || ''
      const devices = !statusError && data ? data.devices : []
      const notice = feedback?.scope === 'web' ? feedback : null
      const offer = notice?.link && devices.some((dev) => dev.device_id === notice.link.deviceId && ready(dev)) ? notice.link : null
      const disabled = busy || web.loading || Boolean(web.error)
      const hubIn = hub ?? data?.hub_url ?? ''
      const pairingHub = joined ? data.hub_url : hubAddress(hubIn, true)
      // Google requires a Hub origin. Keep the existing invitation behavior for
      // older deployments that serve the Web API under a path.
      const googleHub = /^https?:\/\/[^/]+\/?$/i.test(pairingHub) ? pairingHub : ''
      const googleSignedIn = data?.login_provider === 'google'
      const googleNotice = !googleSignedIn && feedback?.scope === 'google' &&
        (feedback.hub === undefined || feedback.hub === googleHub) ? feedback : null
      const ownUrl = parseWebUrl(data?.web_url)
      const advertisedUrl = parseWebUrl(data?.advertised_web_url)
      const advertisedKnown = data && Object.hasOwn(data, 'advertised_web_url')
      const webIn = webDraft ?? ownUrl?.origin ?? advertisedUrl?.origin ?? ''
      const newUrl = parseWebUrl(webIn.trim())
      const canSaveUrl = newUrl && newUrl.origin !== ownUrl?.origin && (!advertisedKnown || newUrl.origin === advertisedUrl?.origin)
      const hasPresence = typeof data?.web_url === 'string' && Boolean(data.web_url)

      function post(path, payload, finish) {
        if (disabled) return
        void run('web', async ({ controller }) => {
          const result = await request('/web' + path, controller.signal, payload)
          return () => finish(result)
        })
      }

      function acknowledge(path, payload, text, update) {
        post(path, payload, (result) => {
          requireOk(result)
          update?.()
          return { text }
        })
      }

      function setPresence(url) {
        acknowledge('/presence', { web_url: url }, url ? '本机 Web 地址已保存。' : '本机 Web 已关闭。', () => {
          updateWeb((status) => ({ ...status, web_url: url }))
          setWebDraft(null)
        })
      }

      function startGoogle() {
        if (disabled || googleSignedIn || !googleHub) return
        void run('google', async (action) => {
          action.tab = reserveTab()
          const result = await request(GOOGLE_START_PATH, action.controller.signal, { hub_url: googleHub }).catch((error) => {
            if (error?.status === 404 && ['not_found', 'http_404'].includes(error.message)) throw new Error('google_not_configured')
            throw error
          })
          return () => {
            const url = googleAuthorizationUrl(result.authorization_url)
            if (!url) throw new Error('invalid_google_authorization_url')
            if (!action.tab) return {
              text: '浏览器阻止了弹出窗口。请点击下方链接，在新标签页完成 Google 登录。',
              // The explicit link lives only in this panel, never in browser storage.
              href: url.href, hub: googleHub,
            }
            if (action.tab.closed) throw new Error('popup_closed')
            action.tab.location.replace(url.href)
            action.tab = null // Leave the sign-in tab to the user. Check only local status.
            return { text: '请在新标签页完成 Google 登录，再返回这里。登录状态会自动刷新。', hub: googleHub }
          }
        })
      }

      function openDevice(device) {
        if (disabled || !ready(device)) return
        void run('web', async (action) => {
          action.tab = reserveTab()
          const result = await request('/web/open', action.controller.signal, { device_id: device.device_id })
          return () => {
            const url = parseWebUrl(result.entry_url, ENTRY_PATH)
            if (!url) throw new Error('invalid_entry_url')
            if (url.origin === (advertisedUrl ?? ownUrl)?.origin) throw new Error('web_url_same_device')
            if (!action.tab) return {
              text: '浏览器未能预先打开标签页，请点击链接继续。',
              link: { href: url.href, deviceId: device.device_id, name: deviceName(device) },
            }
            if (action.tab.closed) throw new Error('popup_closed')
            action.tab.location.replace(url.href)
            action.tab = null // this tab now belongs to the user, not to panel cleanup
            return { text: '已发起打开远端 DSH Web。首次访问请在目标 DSH 登录。' }
          }
        })
      }

      function unpair(device) {
        if (disabled || !window.confirm('解除与「' + deviceName(device) + '」的 Web 配对？这不会影响会话同步配对。')) return
        acknowledge('/unpair', { device_id: device.device_id }, '已解除 Web 配对。', () => {
          updateWeb((status) => ({ ...status, devices: status.devices.filter((dev) => dev?.device_id !== device.device_id) }))
        })
      }

      return h('div', { style: S.wrap }, h('div', { style: S.page },
        h('div', { style: S.head },
          h('h1', { style: { ...S.heading, fontSize: 15 } }, '跨设备'),
          button(web.loading ? '刷新中…' : '刷新', { disabled: busy || web.loading, onClick: () => void refresh() }),
        ),
        data ? h('section', { 'aria-label': 'Web 登录与配对', style: S.section },
          h('h2', { style: S.heading }, 'Web 登录与配对'),
          h('p', { style: S.meta }, '在各台设备上使用同一中继和同一个 Google 账号登录，设备会自动配对，无需邀请码。这不会替代目标 DSH 自身的登录。'),
          joined ? h('p', { style: S.meta }, '中继地址（固定）：', data.hub_url || '未知') : null,
          googleSignedIn ? message('已通过 Google 登录') : h('div', { style: S.form },
            joined ? h('p', { style: S.meta }, '登录会将 Google 账号关联到现有 Web 身份，保留原有配对。') :
              field('Web 配对中继地址', { type: 'url', value: hubIn, disabled: busy, placeholder: 'https://hub.example.com', onChange: (event) => {
                setHub(event.target.value)
                clearFeedback('google')
              } }),
            !joined && hubIn.trim() && !pairingHub ? message('请填写 HTTPS 中继地址；只有本机回环中继可使用 HTTP。', true) : null,
            pairingHub && !googleHub ? message('Google 登录需要不带路径的中继根地址。', true) : null,
            joined && !pairingHub ? message(ERRORS.invalid_hub_url, true) : null,
            button('使用 Google 登录', { disabled: disabled || !googleHub, onClick: startGoogle }, true),
          ),
          googleNotice ? message(googleNotice.text, googleNotice.error) : null,
          googleNotice?.href ? h('a', { href: googleNotice.href, target: '_blank', rel: 'noopener noreferrer' }, '在新标签页继续 Google 登录') : null,
        ) : null,
        h('section', { 'aria-label': '已配对的 Web 设备', 'aria-busy': web.loading, style: S.section },
          h('h2', { style: S.heading }, '已配对的 Web 设备'),
          h('p', { style: S.meta }, '在线且已开放 Web 的设备会在新标签页打开原生 DSH Web。'),
          web.loading && !data ? message('正在加载 Web 设备…') : null,
          statusError ? h('div', { style: S.row }, message('读取 Web 设备失败。' + statusError, true),
            button('重试', { disabled: busy || web.loading, onClick: () => void refresh() })) : null,
          data && !statusError && devices.length === 0 ? message('暂无已配对的 Web 设备。') : null,
          devices.length ? h('ul', { role: 'list', style: S.list }, devices.map((device) => h('li', { key: device.device_id, style: S.device },
            h('div', { style: { ...S.row, minWidth: 0 } },
              h('span', { style: S.dot(device.status === 'online'), 'aria-hidden': true }),
              h('span', { style: S.name }, deviceName(device)),
              h('span', { style: S.tag }, device.status === 'online' ? '在线' : '离线'),
              !device.web_enabled ? h('span', { style: S.tag }, '未开放 Web') : null,
            ),
            h('div', { style: S.row },
              button('打开 Web', { disabled: disabled || !ready(device), 'aria-label': '在新标签页打开 ' + deviceName(device) + ' 的 DSH Web', onClick: () => openDevice(device) }),
              button('解除配对', { disabled, 'aria-label': '解除与 ' + deviceName(device) + ' 的 Web 配对', onClick: () => unpair(device) }),
            ),
          ))) : null,
        ),
        busy ? message('正在处理…') : null,
        notice ? message(notice.text, notice.error) : null,
        offer ? h('a', { href: offer.href, target: '_blank', rel: 'noopener noreferrer' }, '在新标签页打开 ' + offer.name + ' 的 DSH Web') : null,
        data ? h('details', { style: { ...S.section, display: 'block' } },
          h('summary', { style: { ...S.heading, cursor: 'pointer' } }, 'Web 邀请码配对（备用）'),
          h('div', { style: { ...S.form, paddingTop: 6 } },
            data.can_enroll ? h('div', { style: S.form },
              h('p', { style: S.meta }, '可使用本机已配置的实例凭据启用 Web 身份，不会自动开放 Web。'),
              button('启用本机 Web 身份', { disabled, onClick: () => acknowledge('/enroll', {}, '本机 Web 身份已启用。') }),
            ) : null,
            joined ? h('div', { style: S.form },
              button('生成 Web 邀请码', { disabled, onClick: () => post('/pairing/code', {}, (result) => {
                setInvite(invitation(result, WEB_CODE))
                return { text: '请在另一台设备的 Web 配对页输入此中继地址及邀请码。' }
              }) }),
              showInvitation(invite, 'Web 邀请码'),
            ) : null,
            form(() => {
              const entered = code.trim()
              if (!pairingHub || !WEB_CODE.test(entered)) return
              acknowledge('/pairing/claim', { hub_url: pairingHub, code: entered }, 'Web 配对成功。', () => setCode(''))
            },
              h('p', { style: S.meta }, '上方中继地址须与生成邀请码的设备一致。'),
              field('24 位 Web 邀请码', { value: code, disabled: busy, spellCheck: false, autoCapitalize: 'none', onChange: (event) => setCode(event.target.value) }),
              button('使用 Web 邀请码配对', { type: 'submit', disabled: disabled || !pairingHub || !WEB_CODE.test(code.trim()) }),
            ),
          ),
        ) : null,
        data ? h('section', { 'aria-label': '本机 Web', style: S.section },
          h('h2', { style: S.heading }, '本机 Web', data.device_name ? ' · ' + data.device_name : ''),
          h('p', { style: S.meta }, '仅填写已可访问、可信任的独立 DSH Web HTTPS 根地址，不带路径、查询参数、片段或令牌。这里不是隧道，也不会配置转发。首次访问请在目标原生 DSH Web 登录。关闭 Web 只撤下配对页的入口，不会停止 DSH。'),
          h('p', { style: S.meta }, ownUrl ? '已开放 Web：' + ownUrl.origin : hasPresence ? '已保存的地址无效，请修改或关闭 Web。' : '未开放 Web'),
          joined && advertisedKnown ? h('p', { style: S.meta }, advertisedUrl
            ? 'DSH 已声明的 HTTPS 地址：' + advertisedUrl.origin
            : '本机 DSH 尚未声明可用的 HTTPS 地址，请先配置 DSH 的 --public-url 和 --trusted-host。') : null,
          joined ? form(() => { if (canSaveUrl) setPresence(newUrl.origin) },
            field('本机 DSH Web HTTPS 地址', { type: 'url', value: webIn, disabled: busy, placeholder: 'https://dsh.example.com', onChange: (event) => setWebDraft(event.target.value) }),
            h('div', { style: S.row },
              button(hasPresence ? '保存 Web 地址' : '开放 Web', { type: 'submit', disabled: disabled || !canSaveUrl }),
              hasPresence ? button('关闭 Web', { disabled, onClick: () => setPresence(null) }) : null,
            ),
            webIn.trim() && !newUrl ? h('p', { style: S.error }, ERRORS.invalid_web_url) : null,
            newUrl && advertisedUrl && newUrl.origin !== advertisedUrl.origin
              ? h('p', { style: S.error }, '地址须与本机 DSH 已声明的 HTTPS 地址一致。') : null,
          ) : h('p', { style: S.meta }, '先启用或配对本机 Web 身份，才可开放 Web。'),
        ) : null,
        h(LegacyPairing, { connection }),
      ))
    }

    // 侧边栏图标栏里的一格:组件会被当作「图标」渲染,只放一个小符号。
    function CrossDeviceIcon() {
      return h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '100%', height: '100%', fontSize: 15, lineHeight: 1,
          },
          title: '跨设备',
        },
        '⇄',
      )
    }

    return {
      // 必须声明依赖服务:否则 apply(ctx) 里 ctx.slots 是 undefined,
      // 调用 ctx.slots.inject(...) 抛 TypeError,整个客户端插件静默失败。
      inject: ['slots'],
      apply(ctx) {
        // 内容页:sidebar.panellist 是「图标栏」(组件会被当图标渲染),真正的内容必须
        // 注册到 main 插槽;两者配合——图标点一下打开这个页面。
        const KEY = 'cross-device'
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: KEY,
              order: 100,
              label: () => '跨设备',
            },
            DevicesPanel,
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: KEY,
              order: 10,
              label: () => '跨设备',
            },
            CrossDeviceIcon,
          ),
        )
      },
    }
  },
})