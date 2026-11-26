# Architecture

```
┌──────────────────────────────┐          ┌───────────────────────┐
│ macOS app (`dsh-bridge`)      │          │ hub server          │
│                              │  HTTPS   │ (Node, zero deps)     │
│  DSHReader ──► SyncEngine ───┼─────────►│ /v1/sessions/sync     │
│   ~/.dsh/sessions            │          │ /v1/host/commands     │
│                              │◄─────────┤ /v1/hub/.../fetch   │
│  SwiftUI window / CLI        │  long-   │                       │
└──────────────────────────────┘  poll    │  store (JSON, atomic) │
                                          │  hub hub (in-memory)│
┌──────────────────────────────┐          │  SSE hub              │
│ any other client (future:    │◄────────►│                       │
│ iOS, web, another Mac)       │  HTTP    └───────────────────────┘
└──────────────────────────────┘
```

## Two data paths

**Store and forward.** The Mac reads DSH sessions, trims them, and pushes a
snapshot. The hub keeps one bounded copy per session, so any client can read
the latest state even when the Mac is asleep or behind a NAT.

**Live hub.** The host keeps one outbound long-poll open. A client asks the
hub for a session with `POST /v1/hub/sessions/{id}/fetch`; the hub
dispatches `session.fetch` to the parked poll, the Mac answers with the current
on-disk session, and the HTTP request resolves. If the host is offline the hub
answers `409 host_offline` or returns the stored copy when `fallback: "stored"`.

The two paths are deliberately separate. Storage gives offline reads without
keeping a permanent connection; the poll gives fresh reads without opening an
inbound port on the Mac.

## Open a paired device’s Web

The Cross-device plugin uses a separate Web pairing authorization in SQLite.
The Hub returns the paired computer’s advertised HTTPS entry after an online
check. The browser reaches the original DSH Web directly through the operator’s
protected network, retaining native DSH authentication and the target’s Web
plugins. This is not a third session sync path or a window mirror. See
[Web access setup](WEB-ACCESS.md).

## Components

| Path | Responsibility |
| --- | --- |
| `apps/server/src/app.js` | routing, auth, error mapping; one process, one data dir |
| `apps/server/src/store.js` | JSON store, atomic replace, revision counter, upsert/skip semantics |
| `apps/server/src/hub.js` | parked long-polls, command ids, timeouts, result correlation |
| `apps/server/src/events.js` | SSE subscribers and fan-out |
| `apps/server/src/model.js` | validation and normalization of pushed sessions |
| `apps/macos/Sources/BridgeSyncKit/DSHReader.swift` | DSH v4 JSONL adapter (`zstd -dc` when compressed) |
| `apps/macos/Sources/BridgeSyncKit/HubClient.swift` | typed HTTP client |
| `apps/macos/Sources/BridgeSyncKit/SyncEngine.swift` | push loop, host loop, command handling |
| `apps/macos/Sources/BridgeSyncCLI` | CLI + SwiftUI window |

## Storage and limits

- One JSON file (`hub-store.json`) under `--data-dir`; every mutation writes a
  temp file and renames it, so a crash cannot tear the file.
- Mutations are serialized in-process. **Run exactly one hub process per data
  directory**; this is not a clustered store. A SQLite or PostgreSQL backend is
  the natural next step and is not implemented.
- Sessions are capped at 2000 messages, 20 000 chars per message, and 16 MiB per
  request, which keeps a full read bounded.
- Device tokens are stored as SHA-256 digests, never plaintext.

## How this relates to the two reference projects

Both references solve the same problem with different trade-offs; this MVP picks
the smallest slice that still gives *hub-mediated session sync*.

- [ds-harness-remote](https://github.com/liguobao/ds-harness-remote) — WebSocket control
  plane, blind hub, Noise E2E; the server never stores session content.
- [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin) — host dials out over
  WSS with a binary frame codec and QR/code pairing.

| | ds-harness-remote | dsh-mobile-plugin | dsh-bridge (this repo) |
| --- | --- | --- | --- |
| Transport | WebSocket control + blind hub + optional WebRTC/TURN | outbound WSS tunnel, binary frames | HTTP long-poll, no websocket |
| Session content on server | never (Noise ciphertext only) | not stored; host answers live | bounded copy stored + live passthrough |
| Pairing | account login + device registration | QR/code pairing, HKDF-sealed | instance token + device token |
| End-to-end encryption | Noise IK | per-device keys | **not implemented** (see SECURITY) |
| Client surface | full app | mobile app + host plugin | macOS CLI + SwiftUI (session sync only) |

Kept from the references: host dials outward, device identity carried on every
request, monotonic server revision for incremental reads, explicit
"live vs stored" distinction, and a strict "the host owns the data" boundary.

Not copied on purpose, for MVP scope: websockets/framing, Noise handshake,
WebRTC/TURN, mirror snapshots, blob transfer, push notifications, multi-account.
