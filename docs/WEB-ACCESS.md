# Open remote DSH Web with Google

The Cross-device plugin lists devices that use the same verified Google account
on the same Hub. There is no Web pairing code and no per-device public address.

1. Update the Hub and the plugin on both devices. Run DSH Web as normal on both;
   keep the target listener on loopback.
2. Open **跨设备 → 使用 Google 登录** on both devices with the same account.
   If prompted, enter the **Hub** URL, not a URL for the other DSH.
3. On the device you want to control, open its local DSH page and enable
   **允许远程控制本机**. It starts off on every DSH restart. The target uses an outbound connection;
   no DNS setup, certificate, port forwarding, or VPN is needed for either Mac.
4. From the other device, click **打开 Web** next to the target. The new tab opens
   the target's DSH Web, including its sessions and plugins, not its desktop.

Use a Hub you trust. The Hub authenticates device identity and routes encrypted
traffic. Deploy it behind HTTPS with WebSocket upgrades for
`/api/v1/web/relay`. Production does not accept plaintext Hub connections. Both Macs
must be awake and running DSH for control. The plugin uses the installed DSH
Web authentication service on the target; its native owner credential never
crosses the Hub and is not exposed to the viewing browser.

## Browser-only entry (optional)

A configured Hub serves the device list at its HTTPS origin plus /remote.
A viewing phone or computer needs only a browser. Sign into Google with the
same account as the target, then select an online target that has explicitly
allowed access from the server website. This opens the target’s actual DSH
Web, not a copy of its UI. Both target switches start off after a DSH restart.
Turning either switch off disconnects active browser sessions. The original
plugin-to-plugin mode does not require enabling the browser mode.

**Trust the Hub and its HTTPS reverse proxy.** This mode terminates the Web
session on your server, which can read the DSH content and act with DSH owner
permissions while the portal lease is valid. The target’s native DSH cookie
stays on the target. The browser never receives a persistent Web device token.

Set BRIDGE_PORTAL_ORIGIN to the exact HTTPS origin of the existing Hub Google
callback, without a trailing slash. Set BRIDGE_PORTAL_DATA_DOMAIN to a separate
dedicated subdomain, such as views.example.net. Configure wildcard DNS and
correctly validated HTTPS for *.views.example.net. Route those hosts to the
same Hub process, preserving the original Host, and allow WebSocket upgrades.
By default the data origin uses standard HTTPS (443). For a separate HTTPS
listener on 8443, set BRIDGE_PORTAL_DATA_PORT=8443 and forward the complete
Host including :8443. This setting alone only changes the public data URL.
For direct TLS, also set BRIDGE_PORTAL_TLS_CERT_FILE and
BRIDGE_PORTAL_TLS_KEY_FILE to absolute paths readable by the Hub service. The
built-in listener binds IPv4 port 8443 and serves only the data origin. The
ordinary Hub stays on loopback. Renew the trusted wildcard certificate before
it expires; the built-in listener reads it on restart. A DNS-only listener
publishes the origin IP and may be unreachable from networks that block 8443.
Make the wildcard data host scope exclusive to the portal; disable response
caching, content modification and logging of query strings, headers or bodies.
Rate-limit new login attempts by trusted client IP at the edge. Verify TLS
on both legs if an external edge terminates public TLS. Never cache /remote or
data responses. The portal is off when both variables are unset. Partial or
mismatched configuration fails startup. Do not use path-based isolation on
the main Hub origin or reuse data hostnames across sessions. The login session
lasts one hour; individual views follow bounded relay leases and each uses a
different origin. The portal exposes native DSH Web and its MUX; it does not
expose target sign-in, cross-device controls, or arbitrary custom HTTP routes.
Use a current browser (Safari 16.4 or later); some native operations require
[Fetch Metadata headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site).

## Hub setup: enable Google sign-in

Each computer signs in with the same allowlisted account. Upgrade both ends of
the device relay with the Hub. Old invitation-based Web identities can sign in
with Google without resetting their identity or legacy sync settings.

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

## Access and revocation

- The switch grants the other devices on the same Google account **DSH owner
  access** while it is on. This includes actions DSH itself allows, such as
  running Agent turns and using enabled terminals. It is not OS screen sharing.
- Turning the switch off from the target's local DSH immediately closes its
  active relay sockets and prevents reconnection with an old lease. It cannot
  undo actions already taken or revoke other independent DSH access paths.
  If another device is lost, turn off remote control on each target. Existing
  Web credentials are persistent, and legacy unpairing is not device revocation.
- The outbound WSS connections to the Hub carry TLS encrypted browser traffic.
  The viewer pins the server certificate identity provided by the trusted Hub.
  The Hub can observe device identities, connection metadata and traffic sizes;
  trust it to report authorization and certificate bindings correctly.
- The viewing browser uses a fresh local hostname per session to keep cookies
  separate from its own DSH and other local services. Native DSH logins stay
  separate. The target runs
  its ordinary HTTP and WebSocket authentication locally; the new browser tab
  doesn't receive the target's DSH login cookie, and cannot visit the target's
  Cross-device settings or identity endpoints through the relay.
- The old DSH Web invitation and direct URL APIs remain on the Hub for older
  clients, but never grant access to this new relay. Legacy iOS/macOS session
  sync is separate and unchanged.
