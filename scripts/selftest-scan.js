import { scanAllSessions, deterministicUuid } from '../lib/scan.js'

const sessions = scanAllSessions()
console.log('sessions found:', sessions.length)
if (!sessions.length) process.exit(1)

const s = sessions[0]
console.log('--- first session ---')
console.log('id:', s.session_id)
console.log('title:', s.title)
console.log('cwd:', s.cwd)
console.log('updated_at:', s.updated_at)
console.log('messages:', s.messages.length)
for (const m of s.messages.slice(0, 3)) {
  console.log(`  [${m.role}] seq=${m.seq} id=${m.msg_id} :: ${m.content.slice(0, 60).replace(/\n/g, ' ')}`)
}

// 幂等性:同一 (session, seq) 必须得到同一 msg_id
const a = deterministicUuid(s.session_id, 42)
const b = deterministicUuid(s.session_id, 42)
const c = deterministicUuid(s.session_id, 43)
console.log('--- determinism ---')
console.log('same input equal:', a === b)
console.log('different seq differs:', a !== c)
console.log('uuid format ok:', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a))

let total = 0
for (const x of sessions) total += x.messages.length
console.log('total messages across all sessions:', total)
