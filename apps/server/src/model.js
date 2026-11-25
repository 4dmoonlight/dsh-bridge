import { HttpError, clipText, isIsoDate } from './util.js';

export const ROLES = new Set(['user', 'assistant', 'system']);
export const MAX_MESSAGES = 2000;
export const MAX_TEXT = 20000;

/**
 * Validate and normalize one session pushed by a host.
 * Keep this strict: the relay stores whatever passes, and clients render it.
 */
export function normalizeSession(input, deviceId, revision) {
  if (!input || typeof input !== 'object') throw new HttpError(422, 'invalid_session');
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id || id.length > 200) throw new HttpError(422, 'invalid_session_id');

  const messages = Array.isArray(input.messages) ? input.messages : [];
  if (messages.length > MAX_MESSAGES) throw new HttpError(422, 'too_many_messages', `session ${id}`);

  const normalizedMessages = messages.map((m, index) => {
    if (!m || typeof m !== 'object') throw new HttpError(422, 'invalid_message', `${id}#${index}`);
    const role = typeof m.role === 'string' ? m.role : 'assistant';
    if (!ROLES.has(role)) throw new HttpError(422, 'invalid_message_role', `${id}#${index}`);
    const text = typeof m.text === 'string' ? clipText(m.text, MAX_TEXT) : '';
    const createdAt = isIsoDate(m.createdAt) ? m.createdAt : undefined;
    return { role, text, ...(createdAt ? { createdAt } : {}) };
  });

  const updatedAt = isIsoDate(input.updatedAt) ? input.updatedAt : new Date().toISOString();
  const createdAt = isIsoDate(input.createdAt) ? input.createdAt : updatedAt;

  return {
    id,
    deviceId,
    title: typeof input.title === 'string' && input.title.trim() ? clipText(input.title.trim(), 300) : id,
    workspace: typeof input.workspace === 'string' ? clipText(input.workspace, 500) : '',
    engine: typeof input.engine === 'string' ? clipText(input.engine, 100) : 'dsh',
    createdAt,
    updatedAt,
    messageCount: normalizedMessages.length,
    messages: normalizedMessages,
    revision,
    syncedAt: new Date().toISOString(),
  };
}

export function summaryOf(session) {
  const last = session.messages?.[session.messages.length - 1];
  return {
    id: session.id,
    deviceId: session.deviceId,
    title: session.title,
    workspace: session.workspace,
    engine: session.engine,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    revision: session.revision,
    preview: last ? clipText(last.text.replace(/\s+/g, ' '), 160) : '',
  };
}
