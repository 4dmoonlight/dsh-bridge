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
