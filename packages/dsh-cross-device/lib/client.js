/**
 * 客户端半：侧边栏图标打开 main 插槽里的「跨设备」登录与远程控制页。
 * 本文件不经构建；使用宿主提供的 React，不使用 JSX。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cross-device',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef, useCallback } = require('react')

    const API = '/api/cross-device'
    const GOOGLE_START_PATH = '/web/google/start'
    const CONTROL_PATH = '/web/control'
    const GOOGLE_ORIGIN = 'https://accounts.google.com'
    const GOOGLE_AUTH_PATH = '/o/oauth2/v2/auth'
    const STATUS_PATH = '/web/status'
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
      relay_not_ready: '中继尚未就绪，请稍后重试。',
      relay_unavailable: '无法连接远程控制中继，请检查连接后重试。',
      target_unavailable: '对方设备当前不可访问，可能已离线或关闭远程控制。',
      device_not_found: '找不到此设备，请刷新设备列表。',
      relay_certificate_error: '无法验证中继的安全凭证，请检查配置后重试。',
      relay_requires_loopback: '本机 DSH 需要监听回环地址才能启用远程控制。',
      relay_not_supported: '本机 DSH 运行环境不支持远程控制，请升级后重试。',
      relay_view_limit: '已打开的远程窗口过多，请关闭不再使用的窗口后重试。',
      local_control_only: '请在本机直接打开 DSH 后修改远程控制设置。',
      unauthorized: '凭据无效或已过期，请检查本机 DSH 配置。',
      hub_error: '无法连接中继，请检查中继连接后重试。',
      hub_unavailable: '无法连接中继，请检查中继连接后重试。',
      invalid_hub_response: '中继返回了无效的响应。',
      web_busy: '本机正在处理另一项 Web 操作，请稍后重试。',
      web_hub_mismatch: '请使用现有 Web 身份所在的中继；各设备必须使用同一中继。',
      google_not_configured: '此中继不支持 Google 登录或尚未配置，请联系中继管理员。',
      invalid_return_origin: '当前 DSH Web 地址无法接收 Google 登录回调。请从中继允许的 DSH Web 地址打开此页后重试。',
      google_account_mismatch: '此 Web 身份已关联其他 Google 账号。请使用原账号登录。',
      google_flow_limit: '此中继的 Google 登录请求过多，请稍后重试。',
      invalid_google_authorization_url: '收到的 Google 登录链接无效，已取消打开。',
      popup_closed: '新标签页已关闭，请重新打开。',
      invalid_hub_url: '中继地址无效。',
      rate_limited: '操作过于频繁，请稍后重试。',
      web_not_joined: '请先使用 Google 登录。',
      google_binding_required: '请先使用 Google 登录。',
      not_paired: '无法访问此设备，请确认双方使用同一个 Google 账号登录。',
      device_offline: '对方设备已离线。',
      web_not_enabled: '对方设备未允许远程控制。',
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
        // These routes require the real browser Origin even under a no-referrer document policy.
        ...(route === GOOGLE_START_PATH || route === CONTROL_PATH ? { referrerPolicy: 'origin' } : null),
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

    function relayEntryUrl(value) {
      // Require an isolated localhost hostname, path and grant before URL normalization.
      if (typeof value !== 'string' || !/^http:\/\/[a-f0-9]{32}\.dsh-relay\.localhost:[1-9][0-9]{0,4}\/dsh-relay-enter#[A-Za-z0-9_-]{43}$/.test(value)) return null
      try {
        const url = new URL(value)
        return url.port && url.href === value ? url : null
      } catch {
        return null
      }
    }

    function hubAddress(value) {
      const address = value.trim()
      if (!/^https?:\/\/[^/]/i.test(address) || /[@?#\\\s\x00-\x1f\x7f]/.test(address)) return ''
      try {
        const url = new URL(address)
        if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return ''
        return url.hostname ? address : ''
      } catch {
        return ''
      }
    }

    function googleHubAddress(value) {
      const address = hubAddress(value)
      return /^https?:\/\/[^/]+\/?$/i.test(address) ? address : ''
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

    function statusValue(data) {
      if (typeof data.joined !== 'boolean' || !Array.isArray(data.devices)) throw new Error('invalid_response')
      // The Web route is authoritative for peers. Keep only fields needed by the
      // panel; do not retain account details or merge the legacy session list.
      const google = data.joined && data.login_provider === 'google'
      return {
        joined: data.joined,
        login_provider: google ? 'google' : null,
        has_hub: typeof data.hub_url === 'string' && Boolean(data.hub_url.trim()),
        hub_url: typeof data.hub_url === 'string' ? googleHubAddress(data.hub_url) : '',
        web_error: data.web_error ? errorMessage({ message: typeof data.web_error === 'string' ? data.web_error : undefined }) : '',
        remote_control_enabled: google && data.remote_control_enabled === true,
        control_ready: google && data.control_ready === true,
        control_error: typeof data.control_error === 'string' && data.control_error ? errorMessage({ message: data.control_error }) : '',
        devices: google ? data.devices.filter((dev) => dev && typeof dev.device_id === 'string' && dev.device_id &&
          (dev.status === 'online' || dev.status === 'offline') && typeof dev.web_enabled === 'boolean')
          .map(({ device_id, device_name, status, web_enabled }) => ({ device_id, device_name, status, web_enabled })) : [],
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
      } catch { /* fallback uses a separate click with no opener */ }
      closeTab(tab)
      return null
    }

    function cancelLoad(instance) {
      const controller = instance.load
      if (!controller) return false
      instance.load = null
      controller.abort()
      return true
    }

    function usePanelRequests() {
      const [web, setWeb] = useState(INITIAL)
      const [busy, setBusy] = useState(false)
      const [feedback, setFeedback] = useState(null)
      const panel = useRef(null)

      const refresh = useCallback(async () => {
        const instance = panel.current
        if (!instance || instance.action || instance.load) return
        const controller = new AbortController()
        instance.load = controller
        const current = () => panel.current === instance && instance.load === controller
        setWeb((view) => ({ ...view, loading: true }))
        try {
          const result = await request(STATUS_PATH, controller.signal)
          if (current()) {
            const value = statusValue(result)
            setWeb({ value, loading: false, error: '' })
            if (value.login_provider === 'google') {
              setFeedback((feedback) => feedback?.scope === 'google' ? null : feedback)
            }
          }
        } catch (error) {
          if (current()) setWeb((view) => ({ ...view, loading: false, error: errorMessage(error) }))
        } finally {
          if (current()) instance.load = null
        }
      }, [])

      useEffect(() => {
        const instance = { load: null, action: null }
        panel.current = instance
        void refresh()
        const timer = window.setInterval(() => void refresh(), 15000)
        const onFocus = () => { void refresh() }
        window.addEventListener('focus', onFocus)
        return () => {
          panel.current = null
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          cancelLoad(instance)
          instance.action?.controller.abort()
          closeTab(instance.action?.tab)
        }
      }, [refresh])

      async function run(scope, perform) {
        const instance = panel.current
        if (!instance || instance.action) return
        const action = { controller: new AbortController(), tab: null }
        instance.action = action
        const current = () => panel.current === instance && instance.action === action
        // A GET started before a mutation may describe the old state even if it
        // arrives last. Cancel it and compare request identity before committing.
        if (cancelLoad(instance)) setWeb((view) => ({ ...view, loading: false }))
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
          }
        }
      }

      const updateWeb = (change) => setWeb((view) => ({ ...view, value: change(view.value) }))
      const clearFeedback = (scope) => setFeedback((feedback) => feedback?.scope === scope ? null : feedback)
      return { web, busy, feedback, refresh, run, updateWeb, clearFeedback }
    }

    function button(text, props, primary = false) {
      const style = { ...S.btn, ...(primary ? S.primary : null), opacity: props.disabled ? 0.6 : 1, cursor: props.disabled ? 'not-allowed' : 'pointer' }
      return h('button', { type: 'button', style, ...props }, text)
    }

    function field(label, props) {
      return h('label', { style: S.field }, label, h('input', { style: S.input, autoComplete: 'off', ...props }))
    }

    function message(text, error = false) {
      return h('p', { role: error ? 'alert' : 'status', style: error ? S.error : S.meta }, text)
    }

    function deviceName(device) { return typeof device.device_name === 'string' && device.device_name ? device.device_name : '未命名设备' }
    function ready(device) { return device.status === 'online' && device.web_enabled === true }

    function DevicesPanel() {
      const { web, busy, feedback, refresh, run, updateWeb, clearFeedback } = usePanelRequests()
      const [hub, setHub] = useState('')
      const data = web.value
      const googleSignedIn = data?.login_provider === 'google'
      const statusError = web.error || data?.web_error || ''
      const devices = !statusError && googleSignedIn ? data.devices : []
      const notice = feedback?.scope === 'web' ? feedback : null
      const offer = notice?.link && devices.some((dev) => dev.device_id === notice.link.deviceId && ready(dev)) ? notice.link : null
      const webDisabled = busy || web.loading || Boolean(web.error)
      const hubFixed = data?.joined || data?.has_hub
      const googleHub = hubFixed ? data.hub_url : googleHubAddress(hub)
      const googleNotice = !googleSignedIn && feedback?.scope === 'google' &&
        (feedback.hub === undefined || feedback.hub === googleHub) ? feedback : null
      const controlEnabled = data?.remote_control_enabled === true
      // Disabling is a local revocation. Never gate it on a Hub response, even
      // when the switch is shown from the last known local status.
      const controlDisabled = busy || !googleSignedIn || (!controlEnabled && (web.loading || Boolean(statusError)))

      function setControl(enabled) {
        if (controlDisabled || enabled === controlEnabled) return
        if (enabled && !window.confirm('开启后，使用同一 Google 账号登录的设备可作为本机 DSH 的所有者使用原生 DSH（包括 DSH 终端）。这不是屏幕共享。确定开启吗？')) return
        void run('web', async ({ controller }) => {
          const result = await request(CONTROL_PATH, controller.signal, { enabled })
          return () => {
            requireOk(result)
            updateWeb((status) => ({ ...status, remote_control_enabled: enabled, control_ready: false, control_error: '' }))
            return { text: enabled ? '已允许远程控制本机。' : '已关闭远程控制，其他设备无法再通过中继访问本机。' }
          }
        })
      }

      function startGoogle() {
        if (webDisabled || googleSignedIn || !googleHub) return
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
        if (webDisabled || !devices.includes(device) || !ready(device)) return
        void run('web', async (action) => {
          action.tab = reserveTab()
          const result = await request('/web/open', action.controller.signal, { device_id: device.device_id })
          return () => {
            const url = relayEntryUrl(result.entry_url)
            if (!url) throw new Error('invalid_entry_url')
            if (!action.tab) return {
              text: '浏览器未能预先打开标签页，请点击下方按钮继续。',
              link: { href: url.href, deviceId: device.device_id, name: deviceName(device) },
            }
            if (action.tab.closed) throw new Error('popup_closed')
            action.tab.location.replace(url.href)
            action.tab = null // This tab now belongs to the user, not to panel cleanup.
            return { text: '已发起打开远端 DSH Web。' }
          }
        })
      }

      function continueOpen() {
        if (!offer || webDisabled) return
        // This second click is a trusted gesture. Keep the secret out of the
        // rendered DOM, including link previews, and out of the opener tab.
        clearFeedback('web')
        try { window.open(offer.href, '_blank', 'noopener,noreferrer') } catch { /* never expose the entry URL in an error */ }
      }

      return h('div', { style: S.wrap }, h('div', { style: S.page },
        h('div', { style: S.head },
          h('h1', { style: { ...S.heading, fontSize: 15 } }, '跨设备'),
          button(web.loading ? '刷新中…' : '刷新', { disabled: busy || web.loading, onClick: () => void refresh() }),
        ),
        web.loading && !data ? message('正在加载跨设备状态…') : null,
        data ? h('section', { 'aria-label': 'Google 登录', style: S.section },
          h('h2', { style: S.heading }, 'Google 登录'),
          h('p', { style: S.meta }, '在各台设备上使用同一中继和同一个 Google 账号登录，即可发现其他设备。'),
          googleSignedIn ? message('已通过 Google 登录') : h('div', { style: S.form },
            data.joined ? h('p', { style: S.meta }, '请将现有 Web 身份关联到 Google 账号，以使用远程控制。') : null,
            hubFixed ? h('p', { style: S.meta }, '登录将使用已配置的中继。') :
              field('中继地址（Hub）', { type: 'url', value: hub, disabled: busy, placeholder: 'https://hub.example.com', onChange: (event) => {
                setHub(event.target.value)
                clearFeedback('google')
              } }),
            (hubFixed || hub.trim()) && !googleHub ? message('Google 登录需要不带路径的 HTTPS 中继根地址；只有本机回环中继可使用 HTTP。', true) : null,
            button('使用 Google 登录', { disabled: webDisabled || !googleHub, onClick: startGoogle }, true),
          ),
          googleNotice ? message(googleNotice.text, googleNotice.error) : null,
          googleNotice?.href ? h('a', { href: googleNotice.href, target: '_blank', rel: 'noopener noreferrer' }, '在新标签页继续 Google 登录') : null,
        ) : null,
        statusError ? h('div', { style: S.row }, message('读取跨设备状态失败。' + statusError, true),
          button('重试', { disabled: busy || web.loading, onClick: () => void refresh() })) : null,
        googleSignedIn ? h('section', { 'aria-label': '本机远程控制', style: S.section },
          h('h2', { style: S.heading }, '本机远程控制'),
          h('label', { style: S.row }, '允许远程控制本机',
            h('input', { type: 'checkbox', role: 'switch', checked: controlEnabled, disabled: controlDisabled, onChange: (event) => setControl(event.target.checked === true) })),
          h('p', { style: S.meta }, '默认关闭，重启 DSH 后需重新开启。关闭后，其他设备对本机 DSH 的中继访问会被切断。'),
          message(!controlEnabled ? '远程控制已关闭。' : data.control_ready && !statusError ? '远程控制已就绪。' : '已允许远程控制，等待中继就绪。'),
          controlEnabled && !data.control_ready && data.control_error ? message(data.control_error, true) : null,
        ) : null,
        googleSignedIn ? h('section', { 'aria-label': '同账号设备', 'aria-busy': web.loading, style: S.section },
          h('h2', { style: S.heading }, '同账号设备'),
          h('p', { style: S.meta }, '在线且允许远程控制的设备可在新标签页打开原生 DSH Web。'),
          !statusError && devices.length === 0 ? message('尚未发现同账号的其他设备。') : null,
          devices.length ? h('ul', { role: 'list', style: S.list }, devices.map((device) => h('li', { key: device.device_id, style: S.device },
            h('div', { style: { ...S.row, minWidth: 0 } },
              h('span', { style: S.dot(device.status === 'online'), 'aria-hidden': true }),
              h('span', { style: S.name }, deviceName(device)),
              h('span', { style: S.tag }, device.status === 'online' ? '在线' : '离线'),
              !device.web_enabled ? h('span', { style: S.tag }, '未开放远程控制') : null,
            ),
            button('打开 Web', { disabled: webDisabled || !ready(device), 'aria-label': '在新标签页打开 ' + deviceName(device) + ' 的 DSH Web', onClick: () => openDevice(device) }),
          ))) : null,
        ) : null,
        busy ? message('正在处理…') : null,
        notice ? message(notice.text, notice.error) : null,
        offer ? button('在新标签页继续打开 ' + offer.name + ' 的 DSH Web', { disabled: webDisabled, onClick: continueOpen }) : null,
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