import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { HttpError, readJson, safeEqual, sendEmpty, sendJson, sha256 } from './util.js';
import { createPortalProxy, PORTAL_DATA_ALT_PORT } from './web-portal-proxy.js';

const PORTAL = '/remote';
const ENTER = '/_dsh/enter';
const LOGIN = '__Host-dsh-portal';
const VIEW = '__Host-dsh-view';
const SESSION_MS = 60 * 60_000;
const GRANT_MS = 45_000;
const MAX_SESSIONS = 64;
const MAX_VIEWS = 4;
const SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const COMMON = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
};
const jsonHeaders = { ...COMMON, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };

const portalScript = (dataDomain, dataPort) => [
  'const message=document.getElementById("status");',
  'const list=document.getElementById("devices");',
  'const login=document.getElementById("login");',
  'const logout=document.getElementById("logout");',
  'const reload=document.getElementById("reload");',
  'const json={"content-type":"application/json"};',
  'const suffix=' + JSON.stringify('.' + dataDomain) + ',port=' + JSON.stringify(dataPort) + ';',
  'const options={credentials:"same-origin",redirect:"error",referrerPolicy:"origin"};',
  'let busy=false;',
  'async function openDevice(id){',
  'if(busy)return;busy=true;for(const b of list.querySelectorAll("button"))b.disabled=true;',
  'try{const r=await fetch("/remote/api/open",{...options,method:"POST",headers:json,body:JSON.stringify({device_id:id})});',
  'if(!r.ok)throw Error();const data=await r.json();const url=new URL(data.entry_url);',
  'if(data.entry_url!==url.href||url.protocol!=="https:"||url.username||url.password||url.port!==port||url.search||url.pathname!=="/_dsh/enter"||!/^#[A-Za-z0-9_-]{43}$/.test(url.hash))throw Error();',
  'if(!url.hostname.endsWith(suffix)||!/^[a-f0-9]{32}$/.test(url.hostname.slice(0,-suffix.length)))throw Error();',
  'location.assign(url.href);',
  '}catch{message.textContent="设备无法连接，可能已关闭网页访问。";}',
  'finally{busy=false;for(const b of list.querySelectorAll("button"))b.disabled=false;}}',
  'async function update(){if(busy)return;busy=true;list.replaceChildren();',
  'try{const r=await fetch("/remote/api/devices",options);if(r.status===401){login.hidden=false;logout.hidden=true;reload.hidden=true;',
  'message.textContent="请用与目标电脑相同的 Google 账号登录。";return;}',
  'if(!r.ok)throw Error();login.hidden=true;logout.hidden=false;reload.hidden=false;',
  'const data=await r.json();if(!Array.isArray(data.devices))throw Error();',
  'message.textContent=data.devices.length?"选择一台电脑打开它的 DSH。":"没有可连接的电脑。在目标电脑上开启服务器网页访问。";',
  'for(const device of data.devices){const li=document.createElement("li"),b=document.createElement("button");',
  'b.type="button";b.textContent=device.device_name;b.addEventListener("click",()=>openDevice(device.device_id));',
  'li.append(b);list.append(li);}}catch{message.textContent="无法获取设备，请刷新页面重试。";}finally{busy=false;}}',
  'reload.addEventListener("click",update);',
  'logout.addEventListener("click",async()=>{try{await fetch("/remote/api/logout",{...options,method:"POST",headers:json,body:"{}"});location.replace("/remote");}catch{message.textContent="退出失败，请重试。";}});',
  'update();',
].join('');

const entryScript = 'const proof=location.hash.slice(1);history.replaceState(null,"","' + ENTER + '");' +
  'const status=document.getElementById("status");' +
  'if(!/^[A-Za-z0-9_-]{43}$/.test(proof)){status.textContent="入口已失效，请回设备列表重新打开。";}' +
  'else fetch("' + ENTER + '",{method:"POST",credentials:"same-origin",redirect:"error",referrerPolicy:"origin",' +
  'headers:{"content-type":"application/json"},body:JSON.stringify({proof})}).then(r=>{' +
  'if(!r.ok)throw Error();location.replace("/");}).catch(()=>{status.textContent="设备无法连接，请回设备列表重试。";});';

function htmlPage(title, main, script, canLogin = false) {
  const hash = createHash('sha256').update(script).digest('base64');
  const content = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><main>' + main + '</main><script>' + script + '</script></html>';
  const policy = "default-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
    (canLogin ? "form-action 'self' https://accounts.google.com; " : "form-action 'none'; ") + "script-src 'sha256-" + hash + "'";
  return (res, head) => {
    res.writeHead(200, { ...COMMON, ...(canLogin ? { 'referrer-policy': 'same-origin' } : {}),
      'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy });
    res.end(head ? undefined : content);
  };
}
const portalPage = (dataDomain, dataPort) => htmlPage('连接远端 DSH',
  '<h1>连接远端 DSH</h1>' +
  '<p role="status" id="status">正在检查登录状态…</p>' +
  '<form method="post" action="/remote/auth/start" id="login" hidden><button type="submit">使用 Google 登录</button></form>' +
  '<button type="button" id="reload" hidden>刷新设备</button> <button type="button" id="logout" hidden>退出</button>' +
  '<ul id="devices"></ul>', portalScript(dataDomain, dataPort), true);
const entryPage = htmlPage('正在打开 DSH', '<p role="status" id="status">正在打开远程 DSH…</p>', entryScript);

function configuration(options) {
  if (!options) return null;
  let origin;
  try { origin = new URL(options.origin); } catch { throw Error('Invalid Web portal origin'); }
  const { dataDomain } = options;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (origin.protocol !== 'https:' || origin.origin !== options.origin || origin.port ||
      !origin.hostname.includes('.') || !origin.hostname.split('.').every(s => label.test(s)) ||
      /^[0-9.]+$/.test(origin.hostname) ||
      typeof dataDomain !== 'string' || dataDomain.length > 210 || !dataDomain.includes('.') ||
      !dataDomain.split('.').every(s => label.test(s)) || /^[0-9.]+$/.test(dataDomain) ||
      origin.hostname === dataDomain || origin.hostname.endsWith('.' + dataDomain)) {
    throw Error('Invalid Web portal HTTPS origins; use a dedicated wildcard domain outside the login host');
  }
  const configuredPort = options.dataPort === undefined ? '443' : options.dataPort;
  const dataPort = typeof configuredPort === 'number' ? String(configuredPort) : configuredPort;
  if (dataPort !== '443' && dataPort !== PORTAL_DATA_ALT_PORT) {
    throw Error('Invalid BRIDGE_PORTAL_DATA_PORT; expected 443 or ' + PORTAL_DATA_ALT_PORT);
  }
  return { origin: origin.origin, controlHost: origin.host, dataDomain, dataPort: dataPort === '443' ? '' : dataPort };
}

function cookieValue(req, name) {
  const headers = req.headersDistinct.cookie ?? [];
  let hits = [];
  for (const h of headers) {
    if (typeof h !== 'string' || h.length > 8192) return null;
    hits = hits.concat(h.split(';').map(item => item.trim()).filter(item => item.startsWith(name + '=')));
  }
  const value = hits.length === 1 ? hits[0].slice(name.length + 1) : '';
  return SECRET.test(value) ? value : null;
}

function setCookie(res, name, value, ms) {
  const sameSite = name === LOGIN ? 'Lax' : 'Strict';
  res.appendHeader('set-cookie', name + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=' + sameSite + '; Max-Age=' +
    Math.max(0, Math.floor(ms / 1000)));
}

function matchesOrigin(req, origin, required = false) {
  const value = req.headersDistinct.origin;
  return value ? value.length === 1 && value[0] === origin : !required;
}

function sameOrigin(req, origin, post = false) {
  const site = req.headersDistinct['sec-fetch-site'];
  return matchesOrigin(req, origin, post) && (!site || (site.length === 1 && site[0] === 'same-origin'));
}

async function jsonBody(req) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'invalid_content_type');
  }
  const limit = 512;
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'payload_too_large');
  try { return await readJson(req.iterator({ destroyOnReturn: false }), limit); }
  catch (error) { req.resume(); throw error; }
}

function exactKeys(value, ...keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

function delayed(ms, action) {
  const timer = setTimeout(action, Math.max(0, ms));
  timer.unref();
  return timer;
}

export function createWebPortal({ options, relay }) {
  const config = configuration(options);
  if (!config) return null;
  const renderPortal = portalPage(config.dataDomain, config.dataPort);
  const portSuffix = config.dataPort ? ':' + config.dataPort : '';
  const dataSuffix = '.' + config.dataDomain + portSuffix;

  function isDataRequest(req) {
    // The public listener admits the exact authority shape, even for an unbound label.
    const host = req.headers.host;
    return req.headersDistinct.host?.length === 1 && typeof host === 'string' &&
      host.endsWith(dataSuffix) && /^[a-f0-9]{32}$/.test(host.slice(0, -dataSuffix.length));
  }
  const sessions = new Map();
  const views = new Map();
  let stopped = false;
  const isDataName = name => {
    const hostname = name.replace(/\.+$/, '').toLowerCase();
    return hostname === config.dataDomain || hostname.endsWith('.' + config.dataDomain);
  };
  const belongs = req => (req.headersDistinct.host ?? []).some(host => {
    // Reserve the entire DNS suffix regardless of port or hostname spelling.
    // Never use these aliases to look up a view: only the raw authority can match.
    const name = host.split(':', 1)[0].trim();
    return isDataName(name) || isDataName(domainToASCII(name));
  });

  function dropView(view) {
    if (views.get(view.host) !== view) return;
    views.delete(view.host);
    view.owner.views.delete(view);
    clearTimeout(view.timer);
    view.proxy?.close();
    relay.closePortalLease(view.owner.id, view.leaseId);
  }

  function dropSession(session) {
    if (sessions.get(session.key) !== session) return;
    sessions.delete(session.key);
    clearTimeout(session.timer);
    for (const view of session.views) dropView(view);
  }

  function currentSession(req) {
    const token = cookieValue(req, LOGIN);
    const session = token && sessions.get(sha256(token));
    if (!session || session.expires <= Date.now()) {
      if (session) dropSession(session);
      return null;
    }
    return session;
  }

  function completeAuthentication(req, res, { subject }) {
    if (stopped || req.headers.host !== config.controlHost || typeof subject !== 'string' || !subject ||
        subject.length > 255) throw new HttpError(400, 'invalid_portal_login');
    const previous = currentSession(req);
    if (previous) dropSession(previous);
    // Do not ever create persistent Web device entries or expose Web bearer tokens.
    if (sessions.size >= MAX_SESSIONS) throw new HttpError(429, 'portal_limit');
    const token = randomBytes(32).toString('base64url');
    const session = { id: randomBytes(24).toString('base64url'), key: sha256(token), subjectHash: sha256(subject),
      expires: Date.now() + SESSION_MS, views: new Set() };
    session.timer = delayed(SESSION_MS, () => dropSession(session));
    sessions.set(session.key, session);
    setCookie(res, LOGIN, token, SESSION_MS);
    sendEmpty(res, 303, { ...jsonHeaders, location: PORTAL });
  }

  function makeView(owner, deviceId) {
    if (!owner || sessions.get(owner.key) !== owner || owner.expires <= Date.now()) throw new HttpError(401, 'unauthorized');
    const authority = randomBytes(16).toString('hex') + '.dsh-relay.localhost:3080';
    const host = randomBytes(16).toString('hex') + '.' + config.dataDomain + portSuffix;
    const grant = randomBytes(32);
    const grantHash = createHash('sha256').update(grant).digest('base64url');
    const ticket = randomBytes(32).toString('base64url');
    const lease = relay.openPortalLease({ subjectHash: owner.subjectHash, viewerId: owner.id, deviceId, authority, grantHash });
    if (owner.views.size >= MAX_VIEWS) {
      // Retire an older lease only once the requested target was opened. Origins never change target.
      dropView(owner.views.values().next().value);
    }
    const expires = Math.min(lease.expires_at, owner.expires);
    const origin = 'https://' + host;
    const view = { owner, host, origin, expires, leaseId: lease.lease_id, ticketHash: sha256(ticket),
      authority, fingerprint: lease.fingerprint, grant: grant.toString('base64url'), state: 'pending', key: null, proxy: null };
    owner.views.add(view);
    views.set(host, view);
    view.timer = delayed(Math.min(GRANT_MS, expires - Date.now()), () => dropView(view));
    return { entry_url: origin + ENTER + '#' + ticket };
  }

  function activeView(host) {
    const view = views.get(host);
    if (view && (view.expires <= Date.now() || view.owner.expires <= Date.now() || !sessions.has(view.owner.key))) {
      dropView(view);
      return null;
    }
    return view;
  }

  function hasViewCookie(req, view) {
    const cookie = cookieValue(req, VIEW);
    return view.state === 'active' && cookie && safeEqual(view.key, sha256(cookie));
  }

  async function dataRequest(req, res, host) {
    const view = activeView(host);
    if (!view) throw new HttpError(404, 'not_found');
    if (req.url === ENTER && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!matchesOrigin(req, view.origin)) throw new HttpError(403, 'forbidden_origin');
      return entryPage(res, req.method === 'HEAD');
    }
    if (req.url === ENTER && req.method === 'POST') {
      if (!sameOrigin(req, view.origin, true)) throw new HttpError(403, 'forbidden_origin');
      const body = await jsonBody(req);
      if (activeView(host) !== view || view.state !== 'pending' || !exactKeys(body, 'proof') ||
          typeof body.proof !== 'string' || !SECRET.test(body.proof) || !safeEqual(view.ticketHash, sha256(body.proof))) {
        throw new HttpError(401, 'invalid_portal_grant');
      }
      view.state = 'connecting';
      view.ticketHash = null;
      try {
        view.proxy = createPortalProxy({ authority: view.authority, externalOrigin: view.origin, grant: view.grant,
          fingerprint: view.fingerprint, connectStream: signal => relay.connectPortalStream(view.owner.id, view.leaseId, { signal }) });
        view.grant = null;
        await view.proxy.activate();
        if (stopped || activeView(host) !== view || res.destroyed) throw new Error('Portal closed');
        const token = randomBytes(32).toString('base64url');
        view.key = sha256(token);
        view.state = 'active';
        clearTimeout(view.timer);
        view.timer = delayed(view.expires - Date.now(), () => dropView(view));
        setCookie(res, VIEW, token, view.expires - Date.now());
        return sendEmpty(res, 204, COMMON);
      } catch {
        dropView(view);
        throw new HttpError(409, 'target_unavailable');
      }
    }
    if (!hasViewCookie(req, view)) throw new HttpError(401, 'unauthorized');
    return view.proxy.request(req, res);
  }

  async function controlRequest(req, res, startPortal) {
    if (req.url === PORTAL && (req.method === 'GET' || req.method === 'HEAD')) return renderPortal(res, req.method === 'HEAD');
    if (req.url === PORTAL + '/auth/start' && req.method === 'POST') {
      if (!sameOrigin(req, config.origin, true)) throw new HttpError(403, 'forbidden_origin');
      return startPortal(req, res);
    }
    const listing = req.url === PORTAL + '/api/devices' && req.method === 'GET';
    const opening = req.url === PORTAL + '/api/open' && req.method === 'POST';
    const logout = req.url === PORTAL + '/api/logout' && req.method === 'POST';
    if (!listing && !opening && !logout) throw new HttpError(404, 'not_found');
    if (!sameOrigin(req, config.origin, !listing)) throw new HttpError(403, 'forbidden_origin');
    const session = currentSession(req);
    if (!session) throw new HttpError(401, 'unauthorized');
    if (listing) return sendJson(res, 200, { devices: relay.portalDevices(session.subjectHash) }, jsonHeaders);
    const body = await jsonBody(req);
    if (logout) {
      if (!exactKeys(body)) throw new HttpError(400, 'invalid_body');
      dropSession(session);
      setCookie(res, LOGIN, '', 0);
      return sendEmpty(res, 204, COMMON);
    }
    if (!exactKeys(body, 'device_id') || typeof body.device_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(body.device_id)) throw new HttpError(400, 'invalid_device_id');
    return sendJson(res, 200, makeView(session, body.device_id), jsonHeaders);
  }

  return {
    origin: config.origin,
    dataPort: config.dataPort,
    isDataRequest,
    completeAuthentication,
    async handleHttp(req, res, startPortal) {
      const host = req.headers.host;
      const path = req.url?.split('?', 1)[0];
      const portalRoute = path === PORTAL || path?.startsWith(PORTAL + '/');
      const dataHost = belongs(req);
      if (!portalRoute && !dataHost) return false;
      try {
        if (stopped || req.headersDistinct.host?.length !== 1 || typeof host !== 'string') throw new HttpError(404, 'not_found');
        if (dataHost) await dataRequest(req, res, host);
        else if (host === config.controlHost) await controlRequest(req, res, startPortal);
        else throw new HttpError(404, 'not_found');
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, error instanceof HttpError ? error.status : 502,
            { error: { code: error instanceof HttpError ? error.code : 'portal_unavailable' } }, jsonHeaders);
        } else if (!res.destroyed) res.destroy();
      }
      return true;
    },
    handleUpgrade(req, socket, head) {
      const host = req.headers.host;
      if (!belongs(req)) return false;
      const view = !stopped && req.headersDistinct.host?.length === 1 && activeView(host);
      if (!view || !hasViewCookie(req, view) || !sameOrigin(req, view.origin, true)) {
        socket.on('error', () => {});
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return true;
      }
      try { view.proxy.upgrade(req, socket, head); } catch { socket.destroy(); }
      return true;
    },
    close() {
      stopped = true;
      for (const session of sessions.values()) dropSession(session);
    },
  };
}
