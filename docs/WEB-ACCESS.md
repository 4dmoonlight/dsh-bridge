# Open a paired device's original DSH Web

The Cross-device plugin lists only computers directly paired **for Web access**.
Open an online computer in a separate browser tab. The target's DSH process
serves its own Web plugins, sidebar, workspaces and sessions. This is a new
browser view, not a copy of the window or desktop that the target is displaying.
The macOS CLI/app, iOS app and their session synchronization are unchanged.

## Prerequisites

1. Update the Hub and install the same updated Cross-device plugin in the DSH
   Web profile on both computers. Restart those Web profiles after installation.
   The Hub uses the existing database; no reset is needed. This flow was
   verified with DSH Web 0.2.2-rc.5.
2. On each computer you want to **open**, give its existing DSH Web a dedicated
   HTTPS hostname that the viewing browser can reach, e.g. via an access-controlled
   private proxy/VPN or an outbound HTTPS tunnel. Keep the DSH listener on
   loopback: do not expose its HTTP port to the public Internet. The proxy must
   preserve the browser-facing Host and Origin and forward WebSocket upgrades
   and streaming responses. For a loopback HTTP upstream, add Secure to its
   session cookie on the HTTPS leg. Use a dedicated origin at /, not a subpath.
3. Run that computer's original Web profile with the matching DSH options:

   ```sh
   dsh --profile web --public-url https://dsh-mac.example.com/ --trusted-host dsh-mac.example.com
   ```

   Complete DSH's normal browser login on the viewing browser at this HTTPS
   hostname once, using the launch flow on the target. Treat the startup URL as
   a password: never enter its query string or paste it into the plugin or Hub.

## Google sign-in (recommended)

This removes Web invitation codes. Each computer signs in once with the same
allowlisted Google account on the same Hub. Devices bound to that account
are paired when a device first joins. Existing Web devices keep their ID,
credential, peers and published address when linking Google. This is not
a proxy or a replacement for the target’s DSH login.

1. In [Google Auth Platform](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid),
   configure the consent screen, add your account as a test user if the app
   is in Testing, and create a **Web application** OAuth client. Add this exact
   **Authorized redirect URI** (use the Hub’s real public HTTPS origin):
   `https://hub.example.com/api/v1/web/google/callback`.
2. Set the following environment variables **only for the Hub process**.
   Store the client secret in a restricted file or in your service manager,
   not in the plugin, shell history, chat, or Git:

   ```dotenv
   BRIDGE_GOOGLE_CLIENT_ID=<Web OAuth client ID>
   BRIDGE_GOOGLE_CLIENT_SECRET=<Web OAuth client secret>
   BRIDGE_GOOGLE_REDIRECT_URI=https://hub.example.com/api/v1/web/google/callback
   BRIDGE_GOOGLE_ALLOWED_EMAILS=owner@example.com
   # Optional: only if signing in from DSH itself served at a non-loopback HTTPS origin:
   # BRIDGE_GOOGLE_RETURN_ORIGINS=https://dsh-mac.example.com,https://dsh-laptop.example.com
   ```

   If using the Linux systemd installer, keep these values in a separate
   root-only file (for example `/etc/dsh-bridge/google.env`) and point to it
   from a `systemctl edit dsh-bridge` drop-in with `[Service]` and
   `EnvironmentFile=/etc/dsh-bridge/google.env`. The deploy script regenerates
   the main environment file. Restart the Hub after configuring it. An
   unauthenticated `GET /api/v1/web/google/status` should return `{"enabled":true}`.
   Loopback HTTP is supported for local development. Other Hub origins must
   use HTTPS; use the exact same root Hub URL in the plugin.
3. On each computer, open **跨设备 → 使用 Google 登录**. Use the same Hub and
   Google account. With local DSH at `http://127.0.0.1:<port>` or `http://localhost:<port>`,
   no additional return origin is needed. If you are signing in from a DSH
   page already served at HTTPS, add its exact origin to the return allowlist.
   Finish in the browser where you started. Devices appear automatically.

## Invitation pairing (fallback)

The **Web 邀请码配对** section remains usable when Google is not configured.

1. On the first computer, configure the Hub with its instance token and use
   **启用本机 Web 身份** in Cross-device. This issues a separate Web-device
   credential. An installation that already has a Web-device credential can
   generate a code without the instance token.
2. Generate a **Web pairing code** and claim it on the other computer using the
   same Hub address. The code is single-use and expires in ten minutes. An
   existing Web device may claim a code without creating a second identity.
   Old six-digit session-sync codes do not carry Web pairing authorization;
   existing installations must pair once for Web, without losing sync settings.

## Open a device

On the target, explicitly enable its advertised DSH HTTPS address. That
address must match the target DSH profile's advertised root. Offline peers
stay in the list, but can only be opened while their Web plugin is online and
sharing the address. Click **打开 Web** to switch to the original DSH Web in a new
tab. The first navigation uses a fixed same-origin handoff so an existing DSH
login cookie with SameSite=Strict is available to the page.

## Security boundaries and troubleshooting

- The Hub only authorizes discovery and returns the clean HTTPS entry at click
  time. It never proxies or fetches that address, receives a DSH login token,
  sees DSH web traffic, or injects cookies. Pair only with devices you trust.
- Use HTTPS for the Hub except for a local loopback Hub in development. If Hub
  requests return 404 on an existing installation, upgrade the Hub as well as
  the plugin; there is no fallback to the global session list.
- Pairing does not log you in to DSH or grant any Hub session-sync permission.
  DSH's own owner login controls what the browser can do on the target. Do not
  share owner access with someone who should only see a session transcript.
- Unpairing immediately removes the link on both devices and blocks subsequent
  opens through the Hub. It does **not** log a browser out of DSH or revoke access
  on the target's network. To revoke that access, also revoke it at the HTTPS
  proxy/VPN and follow DSH's browser session revocation procedure.
- If the opened tab says Unauthorized, complete the native DSH login at that
  origin (the Bridge never issues or reshares login credentials). For WebSocket
  failures, verify the trusted-host setting and proxy upgrade handling. If the
  tab is unreachable while the device shows Online, check browser/VPN access;
  Online reflects Web plugin presence at the Hub, not a network probe from your
  browser.
