/**
 * 读取本地 DSH 会话文件,解析出会话元数据与消息。
 *
 * 文件布局:~/.dsh/sessions/<编码工作区>/session-<id>/session.v4.jsonl.zstd
 * 首行是 {"type":"session", id, createdAt, cwd, ...},其后每行是一个带 seq/time 的事件。
 *
 * 只取 user/message 与 assistant/message 两类作为"消息";system/message 是系统提示词
 * (单条常达数万字符),推送它既无意义又浪费带宽,因此跳过。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** 由 (sessionId, seq) 生成确定性 UUID(v5 风格),保证重推幂等。 */
export function deterministicUuid(sessionId, seq) {
  const ns = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex') // URL 命名空间
  const name = Buffer.from(sessionId + ':' + seq, 'utf8')
  const hash = createHash('sha1').update(ns).update(name).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // variant
  const hex = b.toString('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

/** 判断是否为宿主注入的伪用户消息(不是用户真正说的话)。 */
export function isHarnessInjected(text) {
  const t = text.trimStart()
  if (t.startsWith('<system-reminder')) return true
  if (/^Time sampled while preparing turn/.test(t)) return true
  if (t.startsWith('Additional instructions from:')) return true
  return false
}

/** 截断超长正文,与服务端上限保持一致。 */
export function clip(text, max = 20000) {
  return text.length > max ? text.slice(0, max) + '\n…[truncated]' : text
}

/** 把 content 数组里 type==='text' 的片段拼成纯文本。 */
function joinText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

/** 解压并解析单个会话文件。返回 null 表示不是有效会话文件。 */
export function parseSessionFile(file) {
  let raw
  try {
    raw = zstdDecompressSync(readFileSync(file)).toString('utf8')
  } catch {
    return null
  }

  let meta = null
  let title = ''
  let updatedAt = 0
  const messages = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ev
    try {
      ev = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type = ev.type
    if (type === 'session') {
      meta = ev
      continue
    }
    const time = typeof ev.time === 'number' ? ev.time : 0
    if (time > updatedAt) updatedAt = time

    if (type === 'session/title') {
      const t = ev.data && ev.data.title
      if (typeof t === 'string' && t) title = t
      continue
    }
    if (type === 'user/message') {
      const d = ev.data || {}
      const text = joinText(d.content)
      if (!text || isHarnessInjected(text)) continue
      messages.push({
        msg_id: typeof d.id === 'string' && d.id ? d.id : deterministicUuid(meta ? meta.id : file, ev.seq),
        role: 'user',
        content: clip(text),
        created_at: new Date(time || Date.now()).toISOString(),
        seq: ev.seq,
      })
      continue
    }
    if (type === 'assistant/message') {
      const d = ev.data || {}
      const inner = d.message || {}
      const text = joinText(inner.content)
      if (!text.trim()) continue // 只有 reasoning / tool-call 的轮次不推正文
      messages.push({
        msg_id: deterministicUuid(meta ? meta.id : file, ev.seq),
        role: 'assistant',
        content: clip(text),
        created_at: new Date(time || Date.now()).toISOString(),
        seq: ev.seq,
      })
    }
  }

  if (!meta || !meta.id) return null
  // 按文件内 seq 升序,保证顺序稳定
  messages.sort((a, b) => a.seq - b.seq)
  return {
    session_id: meta.id,
    title: title || meta.id,
    created_at: new Date(meta.createdAt || updatedAt || Date.now()).toISOString(),
    updated_at: new Date(updatedAt || meta.createdAt || Date.now()).toISOString(),
    cwd: meta.cwd || '',
    messages,
  }
}

/** 列出所有会话文件路径。 */
export function listSessionFiles(root = SESSIONS_ROOT) {
  const out = []
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsDir = join(root, ws.name)
    let sessions = []
    try {
      sessions = readdirSync(wsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const file = join(wsDir, s.name, 'session.v4.jsonl.zstd')
      try {
        if (statSync(file).isFile()) out.push(file)
      } catch {
        /* 不是会话目录 */
      }
    }
  }
  return out
}

/** 扫描全部会话(按 updated_at 倒序)。 */
export function scanAllSessions(root = SESSIONS_ROOT) {
  const sessions = []
  for (const file of listSessionFiles(root)) {
    const parsed = parseSessionFile(file)
    if (parsed) sessions.push(parsed)
  }
  sessions.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  return sessions
}
