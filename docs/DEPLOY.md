# Deploy the hub on a Linux server

Target: a Debian/Ubuntu-style VPS with root, systemd, git and curl. The script
installs Node 22 if needed, creates a @@hub@@ system user, writes a systemd unit,
generates the instance token, starts the service, health-checks it, and can add a
Caddy site for TLS.

> The macOS app is installed separately with @@install.sh mac@@.

## One command

The repository is public, so the server only needs outbound HTTPS to GitHub:

```
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge
sudo bash scripts/deploy-server.sh --domain hub.example.com
```

No domain / no TLS (LAN or behind your own tunnel):

```
sudo bash scripts/deploy-server.sh --no-caddy
```

Preview without changing anything:

```
bash scripts/deploy-server.sh --print-only --domain hub.example.com
```

If you later fork the repository privately, pass read access once:
```
export GITHUB_TOKEN=github_pat_xxx
sudo -E bash scripts/deploy-server.sh --domain hub.example.com
```

The script prints the hub URL and the instance token at the end. That token is a
password: anyone holding it can read every stored session.

## What it does

1. Verifies Node ≥ 22.5; if missing or too old, installs a private Node 22 runtime
   under @@/opt/node22@@ and links @@node@@/@@npm@@ into @@/usr/local/bin@@.
2. Creates the system user @@hub@@ and the directories @@/opt/dsh-bridge@@
   (code), @@/var/lib/dsh-bridge@@ (data), @@/etc/dsh-bridge@@ (env).
3. Clones or updates the repository (depth 1). When @@--github-token@@ is used, the
   token is removed from the git remote afterwards.
4. Generates @@BRIDGE_TOKEN@@ once into @@/etc/dsh-bridge/env@@ (0640, root:hub)
   and appends @@BRIDGE_PORT@@, @@BRIDGE_HOST=127.0.0.1@@, @@BRIDGE_DATA_DIR@@.
5. Writes @@/etc/systemd/system/dsh-bridge.service@@ with
   @@NoNewPrivileges@@, @@ProtectSystem=strict@@, @@ProtectHome@@ and
   @@ReadWritePaths=$DATA_DIR@@; enables and restarts it.
6. Polls @@http://127.0.0.1:$PORT/healthz@@ until healthy; on failure prints the last
   30 journal lines and exits non-zero.
7. With @@--domain@@ and Caddy installed, writes
   @@/etc/caddy/conf.d/dsh-bridge.caddy@@ (reverse proxy to 127.0.0.1) and reloads
   Caddy. It reminds you to add @@import conf.d/*.caddy@@ if your Caddyfile lacks it.

The hub binds @@127.0.0.1@@ on purpose: only the TLS proxy reaches it.

## Verify the optional browser portal

Enable this only on a Hub and HTTPS edge trusted to handle decrypted DSH
traffic. See [browser portal configuration](WEB-ACCESS.md#browser-only-entry-optional).
The marketing or preview site's certificate is not evidence that random view
hosts are covered. Before testing with real data:

1. Use a fresh, arbitrary DNS label under the dedicated data domain to test
   DNS, the TLS certificate and forwarding of the original Host. On this
   unleased host, /healthz must return HTTP 404 from the portal, not the Hub
   health page. The control origin must still return HTTP 200 for /healthz.
2. Verify GET /remote serves the login page over HTTPS and that
   /remote/api/devices returns HTTP 401 with no session. Confirm the edge
   bypasses caching, preserves WebSocket upgrades and rate-limits new sign-ins.
3. Use an opted-in test device and a modern browser, with no viewer plugin:
   sign in, verify the distinct HTTPS view hostname, load native JS and open
   the native WebSocket. Another account must not see or open the device.
4. Sign out and verify the browser's view disconnects. Reopen it, turn off
   server-web access on the target, and verify the old view cannot reconnect.
   Do not enable either switch automatically during rollout.

On rollback, disable the data-origin edge route first, then revert or disable
the Hub portal. An older Hub or a Hub with the portal disabled must not receive
requests from the wildcard data origin.

## Parameters

| Flag | Default | Meaning |
| --- | --- | --- |
| @@--port@@ | 8787 | hub port (loopback) |
| @@--domain@@ | – | public hostname for Caddy/TLS |
| @@--repo@@ | repository URL | clone source |
| @@--github-token@@ | @@$GITHUB_TOKEN@@ | optional read access (private forks) |
| @@--install-dir@@ | /opt/dsh-bridge | code checkout |
| @@--data-dir@@ | /var/lib/dsh-bridge | @@hub-store.json@@ (plaintext) |
| @@--no-caddy@@ | off | skip Caddy integration |
| @@--print-only@@ | off | print the plan only |

Environment alternatives: @@BRIDGE_PORT@@, @@BRIDGE_REPO_URL@@, @@GITHUB_TOKEN@@,
@@BRIDGE_INSTALL_DIR@@, @@BRIDGE_DATA_DIR@@, @@BRIDGE_TOKEN@@ (pin the token instead of
generating one).

## After deploy (on the Mac)

```
git clone https://github.com/4dmoonlight/dsh-bridge.git && cd dsh-bridge
./install.sh mac --hub https://hub.example.com --token "<token>" --yes
~/.local/bin/dsh-bridge doctor
~/.local/bin/dsh-bridge push --limit 20
```

Check from anywhere: @@curl -fsS https://hub.example.com/healthz@@.

## Upgrade / re-run

```
cd /opt/dsh-bridge && sudo bash scripts/deploy-server.sh --domain hub.example.com
```

Idempotent: pulls @@origin/main@@, keeps the existing token and data, restarts the
service, health-checks again. CI never touches this server; deploys are manual.

## Uninstall

```
sudo systemctl disable --now dsh-bridge
sudo rm -f /etc/systemd/system/dsh-bridge.service /etc/caddy/conf.d/dsh-bridge.caddy
sudo rm -rf /opt/dsh-bridge /etc/dsh-bridge
# data (session snapshots) is separate on purpose:
sudo rm -rf /var/lib/dsh-bridge
sudo userdel hub
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| @@could not resolve a Node 22 tarball@@ | no outbound HTTPS to nodejs.org; install Node ≥ 22.5 manually and re-run |
| @@git clone@@ asks for credentials | repo is private/renamed, or outbound GitHub blocked; pass @@--repo@@ + @@--github-token@@ |
| health check fails, journal shows @@EADDRINUSE@@ | another process owns the port; pick @@--port@@ or stop it |
| 403/502 through Caddy | Caddyfile missing @@import conf.d/*.caddy@@, or @@--domain@@ DNS not pointing here yet |
| hub can read but Mac gets @@401@@ | token mismatch: compare @@/etc/dsh-bridge/env@@ with the Mac config |

## Security notes

- The instance token is printed once and stored at @@/etc/dsh-bridge/env@@; treat
  it as a password and never paste it into a group chat or a commit.
- @@GITHUB_TOKEN@@ passed via environment is preferable to @@--github-token@@ (which
  shows up in the process list); both are removed from git config afterwards.
- The hub stores **plaintext** session snapshots; see [SECURITY.md](SECURITY.md).
  Disk encryption / restricted access on the VPS is your protection.
