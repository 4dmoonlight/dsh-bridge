# Hub protocol (`bridge/1`)

The Mac app and the hub speak one small HTTP protocol. There is no websocket:
the host keeps an outbound long-poll open, so the Mac never needs an inbound port,
a public IP, or a TLS certificate.

Base URL: whatever you deploy, e.g. `http://127.0.0.1:8787`.
All responses are JSON unless noted. Unknown fields are ignored; unknown paths 404.

## Authentication

`Authorization: Bearer <token>` on every request except `/healthz` and `/v1/meta`.
The SSE endpoint also accepts `?token=` because `EventSource` cannot set headers.

| Token | How you get it | What it can do |
| --- | --- | --- |
| instance token | `BRIDGE_TOKEN`, or generated into `<dataDir>/instance-token` on first start | register devices, list/read/delete sessions, call the hub, read SSE |
| device token | `POST /v1/devices/register` | push sessions, keep a host poll open, report results |

Registering the same `name` again rotates the token and invalidates the old one.
This is a single-tenant hub: every valid token can read every stored session.
See [SECURITY.md](SECURITY.md) before exposing it.

## Session shape

```jsonc
{
  "id": "session-abc",            // required, <= 200 chars
  "title": "Fix the hub",
  "workspace": "/work/example-project",
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
Clients should trim before pushing: `dsh-bridge` keeps the last 200 messages and
8 000 characters per message.

## Endpoints

### `GET /healthz` (no auth)
```json
{ "ok": true, "protocol": "bridge/1", "version": "0.1.0", "serverTime": "…", "uptimeSec": 12, "devices": 1, "sessions": 3 }
```

`HEAD /healthz` is answered like `GET` with an empty body, so `curl -I` works.

### `GET /v1/meta` (no auth)
Capabilities, so clients can degrade instead of guessing.

### `POST /v1/devices/register` (instance token)
Request: `{ "name": "mac-mini", "platform": "macos", "hostname": "…", "capabilities": {} }`
Response `201`: `{ "protocol": "bridge/1", "device": { … }, "token": "dev_x.y", "rotated": false }`

### `GET /v1/devices` (instance token)
`{ "devices": [ { "id", "name", "platform", "hostname", "createdAt", "lastSeenAt", "online" } ] }`
`online` is advisory: it means the hub saw this device within 60 s.

### `PUT /v1/devices/self` (device token)
Optional heartbeat / capability update. `204`.

### `POST /v1/sessions/sync` (device token)
```json
{ "protocol": "bridge/1", "full": false, "sessions": [ … ], "deleted": ["session-id"] }
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
The host parks this request. The hub answers `200 { "command": { "id", "method", "params", "createdAt" } }`
when it has work, or `204` when `wait` seconds elapse. `wait` is clamped to 0–55 s.
Only the newest poll for a device receives commands; a new poll cancels the old one.

### `POST /v1/host/commands/{id}/result` (device token)
`{ "ok": true, "result": { "session": { … } } }` or
`{ "ok": false, "error": { "code": "session_not_found", "message": "…" } }`. `204`.

### `POST /v1/hub/sessions/{id}/fetch` (instance token)
```json
{ "deviceId": "dev_x", "fallback": "stored", "timeoutMs": 5000 }
```
- host has a parked poll → hubs `session.fetch` and returns
  `200 { "source": "live", "session": { … } }`;
- host is offline → `409 host_offline`, unless `fallback: "stored"` was sent, in which case
  the stored copy comes back as `{ "source": "stored", … }`;
- host does not answer in time → `504 host_timeout`, or the stored copy when
  `fallback: "stored"` was sent. A proxy in front of the hub (a Cloudflare
  tunnel, for instance) cannot report that the host's socket died, so a dead host
  keeps its poll parked until the wait runs out; without this rule the caller would
  see a timeout where an offline host would have produced the stored copy;
- host reports failure → `502`.

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

## Legacy Web pairing and direct links (compatibility)

These endpoints are not used by the macOS or iOS clients and do not alter the
existing session credentials, pairing codes, or sidebar. Web credentials bind
one installation to a Web device. REST accepts credentials in the Bearer
header, never in a URL. A pairing code links two specific devices; it neither
joins an entire group nor grants a session-sync credential.

| Method and path | Credentials | Request and result |
| --- | --- | --- |
| POST /api/v1/web/enroll | instance | {device_name} → {device_id, token}; bootstrap a Web identity |
| POST /api/v1/web/pairing/code | Web device | {} → {code, expires_at}; 24 URL-safe characters, once, 10 min |
| POST /api/v1/web/pairing/claim | optional Web device | {code, device_name} → {device_id, token?}; creates an identity only without a Web credential |
| POST /api/v1/web/presence | Web device | {device_name, web_url} → {ok: true}; URL is a credential-free HTTPS origin, or null to stop publishing |
| GET /api/v1/web/devices | Web device | {devices: [{device_id, device_name, status, web_enabled}]}; direct pairs only, including offline peers |
| POST /api/v1/web/open | Web device | {device_id} → {url}; rechecks that the target is directly paired, online and publishing a Web origin |
| POST /api/v1/web/unpair | Web device | {device_id} → {ok: true}; removes the link in both directions |

Success is HTTP 200. A missing/invalid Web credential is 401, an unpaired target
is 404, and an offline (heartbeat older than 60 s) or unpublished Web target is
409. The device list never carries URLs, credentials, or sessions. The Hub
returns an entry address only on these legacy endpoints. New plugins do not use
Web enrollment codes or direct address publication. See [Web access setup](WEB-ACCESS.md).

### Google sign-in for Web devices

All paths below are under `/api/v1/web/google`. These routes neither replace
the invitation endpoints nor authenticate to native DSH.

| Method and path | Request and result |
| --- | --- |
| GET /status | `{enabled}`; no OAuth configuration details |
| POST /start | Optional existing Web Bearer; `{device_name, return_origin, challenge}` → `{flow_id, authorization_url, expires_at}`. The challenge is SHA-256 of a local verifier, in base64url. |
| GET /callback | Google supplies code and state. A verified allowed account receives a 303 to the registered DSH origin and fixed `/dsh-bridge-google` path, carrying a single-use `flow_id` and `grant` in the fragment. |
| POST /redeem | `{flow_id, grant, verifier}` → `{device_id, token?}`. One use, short-lived, and bound to the original challenge. Token is returned only for a new Web identity. |

The DSH host keeps the local verifier, requires native owner access and a
browser-bound flow cookie to complete sign-in, and stores any new Web token
itself. First association pairs the device with other devices having the
same verified Google subject. Reauthenticating an already-bound device does
not restore a removed edge in the legacy APIs. [Configuration](WEB-ACCESS.md#hub-setup-enable-google-sign-in).

## Web relay (additive)

HTTPS routes use the Web Bearer credential of a Google-bound device:

| Route | Body or result |
| --- | --- |
| GET /api/v1/web/relay/devices | {devices, control_ready}; other devices with the same Google subject, with online and opt-in state |
| POST /api/v1/web/relay/open | {device_id, authority, grant_hash} → {lease_id, fingerprint, expires_at} |
| POST /api/v1/web/relay/close | {lease_id} → {closed}; idempotently releases the authenticated viewer’s lease |

There is one outbound control socket per opted-in target, and two outbound
socket legs per active data connection, at the exact upgrade path
`/api/v1/web/relay`. Initial frames are `host` (fingerprint), `viewer`
(lease_id), or `join` (connection_id), each with the device token in the first
WSS message, never in a URL. The Hub validates the Google binding and lease.
The authority is a fresh 32-hex-character hostname under .dsh-relay.localhost
plus the temporary loopback port. A lease is bound to the current target
control socket and to the requesting Web device. It is memory-only and expires or is revoked when the control
socket closes. The control socket receives only routing information, not the
entry grant. Browser traffic is carried by a separate TLS session across the
two data socket legs, using bounded base64 chunks and flow-control acknowledgments.

## Optional browser portal (additive)

- The configured HTTPS control host serves /remote. Its POST /remote/auth/start
  uses the existing Google OAuth callback with a separate one-use state and
  initiating-browser proof. Verification does not register a Web device or
  issue a persistent Web token. The portal session is an in-memory host-only
  cookie; it does not confer access to other Hub endpoints.
- The portal lists and opens only live same-subject devices whose current
  authenticated host registration opts in with the exact portal_access:true
  field. Omitted fields preserve the existing desktop behavior. Switching
  portal permission replaces the target generation, revoking active leases.
- Each view uses a fresh HTTPS hostname on the configured data domain. The
  browser exchanges a short-lived one-use fragment proof for a separate
  host-only cookie; the underlying Web relay’s grant and cookie stay on the
  Hub, which relays only to the TLS certificate pinned for the leased target.
  Targets receive normal synthetic loopback Host/Origin and native MUX frames.
  Sign-out, lease expiry, or target generation loss ends relay access.

## Versioning

The string `bridge/1` is sent in `/healthz`, `/v1/meta`, register and sync.
A hub that does not understand a request's `protocol` answers
`400 protocol_mismatch` rather than guessing. Adding optional fields is not a
breaking change; removing or renaming one is.
