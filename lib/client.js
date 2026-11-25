/**
 * 客户端半:侧边栏「跨设备」面板。
 *
 * 插槽选择说明:sidebar.workspaces 是单占用(kind:single)且已被宿主的工作区/会话列表占用,
 * 注册进去会顶掉用户原有列表;因此挂在 sidebar.panellist(kind:list,加法式)。
 *
 * 本文件不经构建,不能写 JSX,统一用 createElement 别名 h。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cross-device',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef, useCallback } = require('react')

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 6px', fontSize: 13, overflow: 'auto', height: '100%' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px', fontWeight: 600 },
      btn: { border: '1px solid var(--dsh-border, #d0d0d0)', background: 'transparent', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 12 },
      dev: { marginTop: 6, borderTop: '1px solid var(--dsh-border, #e0e0e0)', paddingTop: 6 },
      devHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px', fontSize: 12, opacity: 0.85 },
      dot: (online) => ({ width: 7, height: 7, borderRadius: '50%', background: online ? '#22c55e' : '#9ca3af', flex: '0 0 auto' }),
      sess: { padding: '4px 8px', borderRadius: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 },
      title: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 11, opacity: 0.6 },
      msg: { padding: '4px 8px', borderRadius: 6, marginBottom: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.5 },
      me: { background: 'var(--dsh-bg-muted, rgba(120,120,120,0.10))' },
      body: { flex: 1, overflow: 'auto', padding: '4px 2px' },
      tag: { fontSize: 10, padding: '0 4px', borderRadius: 4, border: '1px solid currentColor', opacity: 0.6 },
    }

    async function api(path, init) {
      const res = await fetch(path, init)
      if (!res.ok) throw new Error('http_' + res.status)
      return res.json()
    }

    function DevicesPanel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [openSession, setOpenSession] = useState(null)
      const [messages, setMessages] = useState([])
      const lastSeqRef = useRef(0)
      const prevIdsRef = useRef(new Set())
      const wsRef = useRef(null)

      const loadSidebar = useCallback(async () => {
        try {
          const d = await api('/api/cross-device/sidebar')
          setData(d)
          setError(d && d.disabled ? '未配置中继地址或未启用' : '')
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [])

      useEffect(() => { void loadSidebar() }, [loadSidebar])

      // 请求代次:切换会话或重新加载时递增,过期的响应直接丢弃,避免
      // 「B 的请求晚于 A 返回」把 A 的正文和游标写到 B 的视图上。
      const genRef = useRef(0)

      const loadMessages = useCallback(async (sessionId, reset) => {
        const myGen = genRef.current
        const since = reset ? 0 : lastSeqRef.current
        const d = await api(
          '/api/cross-device/messages?session_id=' + encodeURIComponent(sessionId) +
          '&since_seq=' + since + '&limit=200'
        )
        if (myGen !== genRef.current) return
        if (d.session_id && d.session_id !== sessionId) return
        const incoming = (d.messages || []).filter(
          (m) => !prevIdsRef.current.has(m.msg_id),
        )
        for (const m of incoming) prevIdsRef.current.add(m.msg_id)
        setMessages((prev) => (reset ? (d.messages || []) : prev.concat(incoming)))
        if (incoming.length) lastSeqRef.current = incoming[incoming.length - 1].seq
      }, [])

      const open = useCallback(async (session) => {
        genRef.current += 1
        setOpenSession(session)
        setMessages([])
        lastSeqRef.current = 0
        prevIdsRef.current = new Set()
        try { await loadMessages(session.session_id, true) } catch (e) { setError(String(e.message || e)) }
      }, [loadMessages])

      // 实时更新走 3 秒增量轮询,**不使用浏览器直连 WebSocket**。
      // 原因:浏览器无法在 WS 握手时携带 Authorization 头,只能把 relay token 放进
      // URL,那等于把凭据暴露给前端。轮询经由本机代理转发,token 始终留在 Node 进程里。
      // 同时只保留一个定时器,并在停止后丢弃回调,避免切换会话时泄漏。
      useEffect(() => {
        if (!openSession) return
        let stopped = false
        const timer = setInterval(() => {
          if (stopped) return
          loadMessages(openSession.session_id, false).catch(() => {})
        }, 3000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [openSession, loadMessages])

      if (openSession) {
        return h('div', { style: S.wrap },
          h('div', { style: S.head },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, openSession.title || openSession.session_id),
            h('button', { style: S.btn, onClick: () => { setOpenSession(null); setMessages([]) } }, '返回'),
          ),
          h('div', { style: S.body },
            messages.length === 0
              ? h('div', { style: S.meta }, '暂无消息')
              : messages.map((m) =>
                  h('div', { key: m.msg_id || m.seq, style: Object.assign({}, S.msg, m.role === 'user' ? S.me : null) },
                    h('div', { style: S.meta }, m.role + ' · seq ' + m.seq),
                    m.content,
                  ),
                ),
          ),
        )
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('span', null, '跨设备'),
          h('button', { style: S.btn, onClick: () => void loadSidebar() }, '刷新'),
        ),
        error ? h('div', { style: Object.assign({}, S.meta, { color: '#ef4444' }) }, error) : null,
        !data ? h('div', { style: S.meta }, '加载中…') : null,
        data && data.devices && data.devices.length === 0 && !error
          ? h('div', { style: S.meta }, '暂无设备')
          : null,
        (data && data.devices ? data.devices : []).map((dev) =>
          h('div', { key: dev.device_id, style: S.dev },
            h('div', { style: S.devHead },
              h('span', { style: S.dot(dev.status === 'online') }),
              h('span', { style: { fontWeight: 600 } }, dev.device_name),
              h('span', { style: S.tag }, dev.status === 'online' ? '在线' : '离线'),
              dev.is_self ? h('span', { style: S.tag }, '本机') : null,
            ),
            (dev.sessions || []).length === 0
              ? h('div', { style: Object.assign({}, S.meta, { padding: '2px 8px' }) }, '无会话')
              : dev.sessions.map((s) =>
                  h('div', {
                    key: s.session_id,
                    style: S.sess,
                    onClick: () => void open(Object.assign({}, s, { device_id: dev.device_id })),
                    onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsh-bg-hover, rgba(120,120,120,0.12))' },
                    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
                  },
                    h('div', { style: S.title }, s.title || s.session_id),
                    h('div', { style: S.meta }, (s.updated_at || '').slice(0, 16).replace('T', ' ') + ' · ' + (s.latest_seq || 0) + ' 条'),
                  ),
                ),
          ),
        ),
      )
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