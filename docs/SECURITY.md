# Security

## What this MVP is

A **single-tenant hub** for one operator: it stores session text in plaintext on
the hub host and authenticates everything with bearer tokens. It is designed for
loopback, a private network, or a TLS reverse proxy you control. It is **not**
multi-tenant and it is **not** end-to-end encrypted.

## Threat model

| Actor | Can | Cannot |
| --- | --- | --- |
| anyone with the instance token | read/delete every stored session, register devices, call the hub | reach the Mac unless the host loop is running |
| anyone with a device token | push sessions as that device, keep a host poll, read stored sessions | register other devices (needs instance token) |
| hub operator | read plaintext sessions, see device names and workspaces | read local files the Mac did not push; read anything while offline beyond the stored copy |
| network observer (no TLS) | read tokens and session text | — |
| another local user on the Mac | read config only if file permissions break (0600 is enforced on save) | — |

## Deliberate non-goals (for now)

- **No end-to-end encryption.** `ds-harness-remote` keeps only Noise ciphertext on
  the server; this repo stores readable snapshots. Adding Noise IK (or the
  mobile plugin's HKDF/AES-GCM pairing scheme) is the main roadmap item before
  any public deployment.
- **No end-to-end encryption between devices.** The hub sees plaintext.
- **No per-device read scoping for session sync.** Every session-sync credential
  can read every stored session; isolation is by device ownership of *writes*.
  Web-device credentials do not authenticate to session sync.
- **No audit log.** Actions are not attributed to a person, only to a credential.
- **No automatic token expiry.** Device credentials live until revoked.

## What is enforced today

- **Per-device credentials.** Pairing issues an opaque 32-byte token bound to a
  server-assigned `device_id`, stored only as a SHA-256 digest. A device token
  cannot claim another device's identity (`403 device_mismatch`).
- **Session ownership is immutable.** A session belongs to the device that first
  created it; another device syncing the same `session_id` gets `409
  session_conflict` instead of silently taking it over.
- **Only an admin credential can issue pairing codes.** A device token that is
  stolen cannot pull more devices in.
- **Pairing codes** are 6 digits, single-use, expire in 10 minutes, and the claim
  endpoint is rate limited to 12 attempts per minute.
- **No SQL injection surface:** every value goes through a prepared statement.
- **On-disk hygiene:** data directory 0700, SQLite file 0600, config files 0600.

## Web pairing

- Web-device credentials and invites are distinct from session-sync credentials.
  A Web device can be bootstrapped by the instance token, a Web invitation, or
  a verified allowlisted Google account if configured. A single-use Web invite
  links the claimant to its issuer only. A session token
  or a heartbeat does not authorize discovery or opening of a Web device.
- Google sign-in verifies the ID token and binds Web membership to a hash of
  the stable Google subject, not to the email address. The allowlist controls
  new sign-ins; it does not revoke existing Web credentials or native DSH login.
  Google tokens are not stored. The Hub issues a short-lived grant that is
  delivered to the viewing DSH browser and redeemed with a server-held verifier
  and browser binding. The Hub never transfers a Web credential in a URL.
- The current Web relay requires verified equal Google subjects, not an older
  invitation or a claimed email. The target only accepts new relay streams while
  its opt-in is active and destroys all of them when disabled or disconnected.
- The viewing browser connects to a temporary loopback port and a fresh
  per-view hostname under .localhost for browser cookie isolation. In plugin-to-plugin mode, the plugins
  communicate over TLS inside outbound relay WebSockets. The Hub sees identity
  and routing metadata and vouches for the target certificate fingerprint; it
  does not receive the browser entry proof, DSH cookies or plaintext page traffic
  in normal operation. The Hub itself is part of the trusted control plane.
- The plugin requires same-origin DSH owner admission and local loopback for the
  control switch. The relay gates every browser request, forwards only to the
  target's fixed DSH listener and blocks the target's Cross-device settings
  and login-grant endpoints. The viewing device can still perform DSH owner
  actions for enabled features; the switch is not an OS sandbox.
- Revoking access closes both HTTP and upgraded streams, but does not undo DSH
  actions already taken or revoke separate direct access. The older direct-URL
  API is retained for backward compatibility. See [Web access setup](WEB-ACCESS.md).

## Optional browser portal

- The target must consent separately on its local DSH. The HTTPS edge and Hub
  can see plaintext DSH traffic and have owner access within the lease. The
  existing mode with two plugins does not expose this traffic to the Hub.
- Browser sign-in uses Google and an expiring, in-memory login session instead
  of granting a persistent Web device credential. Every DSH view uses a distinct
  HTTPS origin and a separate host-only cookie. Deploy the view domain solely
  for this service, with authenticated TLS to the Hub, no edge rewriting, and
  no traffic logging or caching. Never put proxied DSH content on the control
  origin. See [portal deployment](WEB-ACCESS.md#browser-only-entry-optional).

## Hardening checklist before exposing it

1. Terminate TLS in front of the hub (Caddy, nginx, Cloudflare Tunnel) — do not
   serve `http://` on a public interface; tokens travel in clear text otherwise.
2. Bind the hub to `127.0.0.1` and publish it only through the proxy
   (`BRIDGE_HOST=127.0.0.1`).
3. Use a 32-byte random instance token (`install.sh` generates one) and keep
   `hub.env` at mode 0600.
4. Rotate device tokens by re-registering (`dsh-bridge register …`); the old token
   stops working immediately.
5. Restrict the data directory (`hub-store.json`) to the hub user; it contains
   plaintext session text.
6. Push as little as you need: `--limit` caps how many sessions are uploaded, and
   the Mac trims to the last 200 messages per session.
7. Treat the hub as untrusted for anything sensitive; run it on a host you
   control, or use a private network (Tailscale/WireGuard).

## Data at rest

| Where | What | Protection |
| --- | --- | --- |
| hub `hub-store.json` | session titles, workspaces, message text | filesystem permissions only — plaintext |
| hub store | device tokens | SHA-256 digests only |
| Mac `~/.dsh-bridge/macos.json` | instance token, device token | 0600 |
| Mac `hub.env` | instance token | 0600 |

## Reporting

Open a GitHub issue without secrets; for anything sensitive use the repository's
private security advisory form.
