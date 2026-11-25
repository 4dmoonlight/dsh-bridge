#!/usr/bin/env node
/**
 * 端到端验收:模拟两台设备,验证跨设备同步的三项验收标准。
 *
 *   node scripts/e2e-hub.mjs --hub http://127.0.0.1:8787 --token <token>
 *
 * 覆盖:
 *   1. A 上报设备与会话后,B 的 sidebar 能看到 A 和该会话
 *   2. B 能拉全量历史;A 再发消息后,B 增量只拿到新的
 *   3. 重复推送同一个 msg_id 不产生重复消息(幂等)
 */

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const HUB = arg('hub', 'http://127.0.0.1:8787').replace(/\/+$/, '')
const TOKEN = arg('token', '')
if (!TOKEN) {
  console.error('缺少 --token')
  process.exit(2)
}

let failures = 0
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

async function call(method, path, body) {
  const res = await fetch(HUB + path, {
    method,
    headers: Object.assign(
      { authorization: 'Bearer ' + TOKEN },
      body === undefined ? {} : { 'content-type': 'application/json' },
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json }
}

const A = 'dev-e2e-a'
const B = 'dev-e2e-b'
const RUN = 'e2e-' + Date.now()
const SID = 'sess-' + RUN
const now = () => new Date().toISOString()

async function main() {
  console.log('hub:', HUB)

  console.log('\n[1] 两台设备心跳')
  const ha = await call('POST', '/api/v1/devices/heartbeat', { device_id: A, device_name: 'E2E-Mac-A', platform: 'macos' })
  const hb = await call('POST', '/api/v1/devices/heartbeat', { device_id: B, device_name: 'E2E-Mac-B', platform: 'macos' })
  check('A 心跳 200', ha.status === 200, 'status=' + ha.status)
  check('B 心跳 200', hb.status === 200, 'status=' + hb.status)

  console.log('\n[2] A 上报会话元数据')
  const sync = await call('POST', '/api/v1/sessions/sync', {
    device_id: A,
    sessions: [{ session_id: SID, title: 'E2E 会话', updated_at: now() }],
  })
  check('sessions/sync 200', sync.status === 200, 'status=' + sync.status)

  console.log('\n[3] A 推两条消息')
  const m1 = { msg_id: 'msg-' + RUN + '-1', role: 'user', content: '第一条', created_at: now() }
  const m2 = { msg_id: 'msg-' + RUN + '-2', role: 'assistant', content: '第二条', created_at: now() }
  const push = await call('POST', '/api/v1/sessions/' + encodeURIComponent(SID) + '/messages', { device_id: A, messages: [m1, m2] })
  check('推送 200', push.status === 200, 'status=' + push.status)
  const inserted = (push.json && push.json.inserted) || []
  check('两条均插入', inserted.length === 2, 'inserted=' + JSON.stringify(inserted))
  const seq2 = inserted.length ? inserted[inserted.length - 1].seq : 0

  console.log('\n[4] 验收1:B 的 sidebar 能看到 A 与该会话')
  const sb = await call('GET', '/api/v1/sidebar')
  const devA = sb.json && (sb.json.devices || []).find((d) => d.device_id === A)
  check('sidebar 含设备 A', Boolean(devA), devA ? devA.device_name + '/' + devA.status : 'missing')
  const sess = devA && (devA.sessions || []).find((s) => s.session_id === SID)
  check('sidebar 含该会话', Boolean(sess), sess ? sess.title : 'missing')
  check('设备 A 在线', Boolean(devA && devA.status === 'online'), devA && devA.status)

  console.log('\n[5] 验收2:B 拉全量历史')
  const full = await call('GET', '/api/v1/sessions/' + encodeURIComponent(SID) + '/messages?since_seq=0&limit=100')
  const msgs = (full.json && full.json.messages) || []
  check('返回两条历史', msgs.length === 2, 'count=' + msgs.length)
  check('按 seq 升序', msgs.every((m, i, arr) => i === 0 || arr[i - 1].seq < m.seq))

  console.log('\n[6] 验收2:A 再发一条,B 增量只拿新的')
  const m3 = { msg_id: 'msg-' + RUN + '-3', role: 'user', content: '第三条', created_at: now() }
  await call('POST', '/api/v1/sessions/' + encodeURIComponent(SID) + '/messages', { device_id: A, messages: [m3] })
  const inc = await call('GET', '/api/v1/sessions/' + encodeURIComponent(SID) + '/messages?since_seq=' + seq2 + '&limit=100')
  const incMsgs = (inc.json && inc.json.messages) || []
  check('增量只返回 1 条', incMsgs.length === 1, 'count=' + incMsgs.length)
  check('增量内容正确', incMsgs.length === 1 && incMsgs[0].msg_id === 'msg-' + RUN + '-3')

  console.log('\n[7] 验收3:重复 msg_id 必须幂等')
  const dup = await call('POST', '/api/v1/sessions/' + encodeURIComponent(SID) + '/messages', { device_id: A, messages: [m1, m3] })
  const dups = (dup.json && dup.json.duplicates) || []
  const dupIns = (dup.json && dup.json.inserted) || []
  check('重复项进 duplicates', dups.length === 2, 'duplicates=' + JSON.stringify(dups))
  check('无新插入', dupIns.length === 0, 'inserted=' + JSON.stringify(dupIns))
  const after = await call('GET', '/api/v1/sessions/' + encodeURIComponent(SID) + '/messages?since_seq=0&limit=100')
  const afterMsgs = (after.json && after.json.messages) || []
  check('总量仍为 3', afterMsgs.length === 3, 'count=' + afterMsgs.length)

  // 回归断言:重复推送不得消耗 seq 号段。早期实现用 INSERT OR IGNORE,
  // 在 AUTOINCREMENT 下仍会占用 rowid,导致 seq 从 2 直接跳到 4。
  const seqs = afterMsgs.map((m) => m.seq)
  const contiguous = seqs.every((s, i, arr) => i === 0 || s === arr[i - 1] + 1)
  check('seq 连续无跳号(重复不消耗序号)', contiguous, 'seqs=' + JSON.stringify(seqs))

  console.log('\n[8] 鉴权')
  const noAuth = await fetch(HUB + '/api/v1/sidebar')
  check('无 token 401', noAuth.status === 401, 'status=' + noAuth.status)

  console.log('\n' + (failures === 0 ? 'E2E OK' : 'E2E FAILED (' + failures + ')'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E ERROR:', err && err.message)
  process.exit(1)
})
