# Deploy the relay on a Linux server

Target: a Debian/Ubuntu-style VPS with root, systemd, git and curl. The script
installs Node 22 if needed, creates a @@relay@@ system user, writes a systemd unit,
generates the instance token, starts the service, health-checks it, and can add a
Caddy site for TLS.

> The macOS app is installed separately with @@install.sh mac@@.

## One command

The repository is public, so the server only needs outbound HTTPS to GitHub:

```
git clone https://github.com/4dmoonlight/dsh-relay-sync.git
cd dsh-relay-sync
sudo bash scripts/deploy-server.sh --domain relay.example.com
```

No domain / no TLS (LAN or behind your own tunnel):

```
sudo bash scripts/deploy-server.sh --no-caddy
```

Preview without changing anything:

```
bash scripts/deploy-server.sh --print-only --domain relay.example.com
```

If you later fork the repository privately, pass read access once:
```
export GITHUB_TOKEN=github_pat_xxx
sudo -E bash scripts/deploy-server.sh --domain relay.example.com
```

The script prints the relay URL and the instance token at the end. That token is a
password: anyone holding it can read every stored session.

## What it does

1. Verifies Node ≥ 22.5; if missing or too old, installs a private Node 22 runtime
   under @@/opt/node22@@ and links @@node@@/@@npm@@ into @@/usr/local/bin@@.
2. Creates the system user @@relay@@ and the directories @@/opt/dsh-relay-sync@@
   (code), @@/var/lib/dsh-relay-sync@@ (data), @@/etc/dsh-relay-sync@@ (env).
3. Clones or updates the repository (depth 1). When @@--github-token@@ is used, the
   token is removed from the git remote afterwards.
4. Generates @@RELAY_TOKEN@@ once into @@/etc/dsh-relay-sync/env@@ (0640, root:relay)
   and appends @@RELAY_PORT@@, @@RELAY_HOST=127.0.0.1@@, @@RELAY_DATA_DIR@@.
5. Writes @@/etc/systemd/system/dsh-relay-sync.service@@ with
   @@NoNewPrivileges@@, @@ProtectSystem=strict@@, @@ProtectHome@@ and
   @@ReadWritePaths=$DATA_DIR@@; enables and restarts it.
6. Polls @@http://127.0.0.1:$PORT/healthz@@ until healthy; on failure prints the last
   30 journal lines and exits non-zero.
7. With @@--domain@@ and Caddy installed, writes
   @@/etc/caddy/conf.d/dsh-relay-sync.caddy@@ (reverse proxy to 127.0.0.1) and reloads
   Caddy. It reminds you to add @@import conf.d/*.caddy@@ if your Caddyfile lacks it.

The relay binds @@127.0.0.1@@ on purpose: only the TLS proxy reaches it.

## Parameters

| Flag | Default | Meaning |
| --- | --- | --- |
| @@--port@@ | 8787 | relay port (loopback) |
| @@--domain@@ | – | public hostname for Caddy/TLS |
| @@--repo@@ | repository URL | clone source |
| @@--github-token@@ | @@$GITHUB_TOKEN@@ | optional read access (private forks) |
| @@--install-dir@@ | /opt/dsh-relay-sync | code checkout |
| @@--data-dir@@ | /var/lib/dsh-relay-sync | @@relay-store.json@@ (plaintext) |
| @@--no-caddy@@ | off | skip Caddy integration |
| @@--print-only@@ | off | print the plan only |

Environment alternatives: @@RELAY_PORT@@, @@RELAY_REPO_URL@@, @@GITHUB_TOKEN@@,
@@RELAY_INSTALL_DIR@@, @@RELAY_DATA_DIR@@, @@RELAY_TOKEN@@ (pin the token instead of
generating one).

## After deploy (on the Mac)

```
git clone https://github.com/4dmoonlight/dsh-relay-sync.git && cd dsh-relay-sync
./install.sh mac --relay https://relay.example.com --token "<token>" --yes
~/.local/bin/relay-sync doctor
~/.local/bin/relay-sync push --limit 20
```

Check from anywhere: @@curl -fsS https://relay.example.com/healthz@@.

## Upgrade / re-run

```
cd /opt/dsh-relay-sync && sudo bash scripts/deploy-server.sh --domain relay.example.com
```

Idempotent: pulls @@origin/main@@, keeps the existing token and data, restarts the
service, health-checks again. CI never touches this server; deploys are manual.

## Uninstall

```
sudo systemctl disable --now dsh-relay-sync
sudo rm -f /etc/systemd/system/dsh-relay-sync.service /etc/caddy/conf.d/dsh-relay-sync.caddy
sudo rm -rf /opt/dsh-relay-sync /etc/dsh-relay-sync
# data (session snapshots) is separate on purpose:
sudo rm -rf /var/lib/dsh-relay-sync
sudo userdel relay
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| @@could not resolve a Node 22 tarball@@ | no outbound HTTPS to nodejs.org; install Node ≥ 22.5 manually and re-run |
| @@git clone@@ asks for credentials | repo is private/renamed, or outbound GitHub blocked; pass @@--repo@@ + @@--github-token@@ |
| health check fails, journal shows @@EADDRINUSE@@ | another process owns the port; pick @@--port@@ or stop it |
| 403/502 through Caddy | Caddyfile missing @@import conf.d/*.caddy@@, or @@--domain@@ DNS not pointing here yet |
| relay can read but Mac gets @@401@@ | token mismatch: compare @@/etc/dsh-relay-sync/env@@ with the Mac config |

## Security notes

- The instance token is printed once and stored at @@/etc/dsh-relay-sync/env@@; treat
  it as a password and never paste it into a group chat or a commit.
- @@GITHUB_TOKEN@@ passed via environment is preferable to @@--github-token@@ (which
  shows up in the process list); both are removed from git config afterwards.
- The relay stores **plaintext** session snapshots; see [SECURITY.md](SECURITY.md).
  Disk encryption / restricted access on the VPS is your protection.
