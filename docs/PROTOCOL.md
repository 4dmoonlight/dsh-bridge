# Relay protocol (`relay/1`)

The Mac app and the relay speak one small HTTP protocol. There is no websocket:
the host keeps an outbound long-poll open, so the Mac never needs an inbound port,
a public IP, or a TLS certificate.

Base URL: whatever you deploy, e.g. `http://127.0.0.1:8787`.
All responses are JSON unless noted. Unknown fields are ignored; unknown paths 404.

## Authentication

`Authorization: Bearer <token>` on every request except `/healthz` and `/v1/meta`.
The SSE endpoint also accepts `?token=` because `EventSource` cannot set headers.

| Token | How you get it | What it can do |
| --- | --- | --- |
| instance token | `RELAY_TOKEN`, or generated into `<dataDir>/instance-token` on first start | register devices, list/read/delete sessions, call the relay, read SSE |
| device token | `POST /v1/devices/register` | push sessions, keep a host poll open, report results |

Registering the same `name` again rotates the token and invalidates the old one.
This is a single-tenant relay: every valid token can read every stored session.
See [SECURITY.md](SECURITY.md) before exposing it.

## Session shape

```jsonc
{
  "id": "session-abc",            // required, <= 200 chars
  "title": "Fix the relay",
  "workspace": "/Users/me/Dev",
  "engine": "dsh",
  "createdAt": "2026-11-20T09:00:00.000Z",
  "updatedAt": "2026-11-20T09:42:11.000Z",
  "messages": [
    { "role": "user|assistant|system", "text": "…", "createdAt": "2026-11-20T09:01:00.000Z" }
  ]
}
```

Server limits: 2000 messages per session, 20 000 characters per message,
300 characters per title, 500 per workspace, 16 MiB per request body.
Clients should trim before pushing: `relay-sync` keeps the last 200 messages and
8 000 characters per message.

## Endpoints

### `GET /healthz` (no auth)
```json
{ "ok": true, "protocol": "relay/1", "version": "0.1.0", "serverTime": "…", "uptimeSec": 12, "devices": 1, "sessions": 3 }
```

### `GET /v1/meta` (no auth)
Capabilities, so clients can degrade instead of guessing.

### `POST /v1/devices/register` (instance token)
Request: `{ "name": "mac-mini", "platform": "macos", "hostname": "…", "capabilities": {} }`
Response `201`: `{ "protocol": "relay/1", "device": { … }, "token": "dev_x.y", "rotated": false }`

### `GET /v1/devices` (instance token)
`{ "devices": [ { "id", "name", "platform", "hostname", "createdAt", "lastSeenAt", "online" } ] }`
`online` is advisory: it means the relay saw this device within 60 s.

### `PUT /v1/devices/self` (device token)
Optional heartbeat / capability update. `204`.

### `POST /v1/sessions/sync` (device token)
```json
{ "protocol": "relay/1", "full": false, "sessions": [ … ], "deleted": ["session-id"] }
```
Response:
```json
{ "ok": true, "accepted": ["…"], "skipped": ["…"], "removed": ["…"], "cursor": 12 }
```
Rules:
- an incoming session with an older `updatedAt` than the stored one is **skipped**, not rejected;
- `full: true` deletes the device's sessions that are absent from `sessions`;
- `cursor` is the server revision after the write and is monotonic across the whole store.

### `GET /v1/sessions` (any token)
Query: `limit` (1–200, default 50), `cursor` (return only revisions greater than this),
`device`, `q` (case-insensitive match on title/workspace/id).
Summaries omit `messages` and include `messageCount` and a 160-char `preview`.

### `GET /v1/sessions/{id}` (any token)
Full session. `404 session_not_found` when unknown.

### `DELETE /v1/sessions/{id}` (instance token, or the owning device)
`204`. A device token may only delete its own sessions (`403` otherwise).

### `GET /v1/events` (SSE)
Events: `ready`, `session.updated` (summary + deviceId), `session.deleted`,
`device.updated`. A comment ping is written every 15 s.

### `GET /v1/host/commands?wait=25` (device token)
The host parks this request. The relay answers `200 { "command": { "id", "method", "params", "createdAt" } }`
when it has work, or `204` when `wait` seconds elapse. `wait` is clamped to 0–55 s.
Only the newest poll for a device receives commands; a new poll cancels the old one.

### `POST /v1/host/commands/{id}/result` (device token)
`{ "ok": true, "result": { "session": { … } } }` or
`{ "ok": false, "error": { "code": "session_not_found", "message": "…" } }`. `204`.

### `POST /v1/relay/sessions/{id}/fetch` (instance token)
```json
{ "deviceId": "dev_x", "fallback": "stored", "timeoutMs": 5000 }
```
- host has a parked poll → relays `session.fetch` and returns
  `200 { "source": "live", "session": { … } }`;
- host is offline → `409 host_offline`, unless `fallback: "stored"` was sent, in which case
  the stored copy comes back as `{ "source": "stored", … }`;
- host does not answer in time → `504 host_timeout`; host reports failure → `502`.

## Errors

```json
{ "error": { "code": "host_offline", "message": "device dev_x is not connected", "details": {} } }
```

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `empty_body`, `protocol_mismatch`, `device_id_required`, `invalid_body` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `wrong_device` |
| 404 | `not_found`, `session_not_found`, `unknown_command` |
| 409 | `host_offline` |
| 413 | `payload_too_large` |
| 422 | `invalid_session`, `invalid_session_id`, `too_many_messages`, `invalid_message`, `invalid_message_role`, `device_name_required` |
| 502 | `host_error` (or the host's own code) |
| 504 | `host_timeout` |

## Versioning

The string `relay/1` is sent in `/healthz`, `/v1/meta`, register and sync.
A relay that does not understand a request's `protocol` answers
`400 protocol_mismatch` rather than guessing. Adding optional fields is not a
breaking change; removing or renaming one is.
