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
- **No pairing codes / QR flow.** Registration needs the instance token.
- **No per-user scoping.** Every valid token can read every stored session.
- **No audit log, rate limiting, or token expiry.** Device tokens live until
  rotated by re-registering the same name.

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
