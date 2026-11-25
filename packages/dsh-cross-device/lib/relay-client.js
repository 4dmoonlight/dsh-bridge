/**
 * Relay REST 客户端:只做 HTTP 调用与错误归类,不含重试策略(重试在 index.js 的队列里)。
 */

export function createRelayClient({ getConfig }) {
  async function request(method, path, body) {
    const cfg = getConfig()
    if (!cfg || !cfg.relay_url || !cfg.relay_token) {
      throw new Error('relay_not_configured')
    }
    const url = cfg.relay_url.replace(/\/+$/, '') + path
    const res = await fetch(url, {
      method,
      headers: {
        authorization: 'Bearer ' + cfg.relay_token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    let json = null
    let parseFailed = false
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      parseFailed = true
      json = null
    }
    // 2xx 但响应不是 JSON(例如被反向代理插入了 HTML 错误页)不能当成功,
    // 否则推送侧会以为已确认并推进水位,消息就永久丢了。
    if (res.ok && parseFailed) {
      const err = new Error('invalid_json_response')
      err.status = res.status
      throw err
    }
    if (!res.ok) {
      const code = json && json.error && json.error.code ? json.error.code : 'http_' + res.status
      const err = new Error(code)
      err.status = res.status
      err.payload = json
      throw err
    }
    return json
  }

  return {
    request,
    heartbeat: (device) => request('POST', '/api/v1/devices/heartbeat', device),
    syncSessions: (payload) => request('POST', '/api/v1/sessions/sync', payload),
    pushMessages: (sessionId, payload) =>
      request('POST', '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/messages', payload),
    sidebar: () => request('GET', '/api/v1/sidebar'),
    messages: (sessionId, sinceSeq, limit) =>
      request(
        'GET',
        '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/messages?since_seq=' + (sinceSeq || 0) + '&limit=' + (limit || 100),
      ),
  }
}
