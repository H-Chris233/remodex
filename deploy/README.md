# Personal self-hosted Remodex

This fork runs Codex on Windows, forwards encrypted sessions through your VPS,
and builds an unsigned iOS app in GitHub Actions. It has no Remodex subscription
gate, RevenueCat initialization, or default APNs registration. Codex still needs
your existing login/subscription or provider configuration on Windows.

## VPS: dedicated HTTPS domain

Requirements: Linux with Docker Engine and Compose v2, a subdomain pointing to
the VPS, and inbound TCP 80/443 (UDP 443 is optional). Use a DNS-only record if
you do not intend to put another proxy in front of Caddy.

```sh
git clone https://github.com/H-Chris233/remodex.git
cd remodex/deploy
cp .env.example .env
# Edit REMODEX_DOMAIN in .env. Use a hostname, without https:// or a path.
docker compose -f compose.yaml -f compose.https.yaml config --quiet
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
curl --fail https://YOUR_RELAY_DOMAIN/health
```

The health endpoint must return `{"ok":true}`. The bridge URL is
`wss://YOUR_RELAY_DOMAIN/relay`. Caddy forwards both WebSockets and the trusted
reconnect HTTP endpoints. Port 9000 is not published. TLS certificates survive
container recreation in the Caddy volumes. Do not use `down -v` during updates.

## VPS: keep an existing reverse proxy

Use this instead of the HTTPS overlay when ports 80/443 already belong to your
existing host proxy:

```sh
docker compose -f compose.yaml -f compose.existing-proxy.yaml config --quiet
docker compose -f compose.yaml -f compose.existing-proxy.yaml up -d --build --wait
curl --fail http://127.0.0.1:9000/health
```

Publish a dedicated HTTPS subdomain through the existing proxy, forwarding **all
paths** to `http://127.0.0.1:9000`, including WebSocket upgrades, `/health`, and
`/v1/trusted/session/resolve`. For a host Caddy instance:

```caddyfile
YOUR_RELAY_DOMAIN {
    reverse_proxy 127.0.0.1:9000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
    }
}
```

The relay trusts the controlled proxy's sanitized client IP headers. Do not
publish 9000 on all interfaces or forward client-supplied IP headers unchanged.
If the existing proxy also runs in Docker, connect it to the `remodex_default`
network and use `relay:9000` instead of the host loopback address.
Avoid access logs containing `/relay/{sessionId}`; these URLs contain pairing
identifiers. The relay's own connection logs redact them. Push stays disabled.

## Windows bridge

Requirements: Node.js 24, Git, and an installed Codex CLI with a completed login.
Use PowerShell as your normal Windows user. This setup does not install or
upgrade Codex. If you already cloned the fork, enter its `phodex-bridge` folder.

```powershell
git clone https://github.com/H-Chris233/remodex.git
cd remodex/phodex-bridge
npm.cmd ci --ignore-scripts
npm.cmd link --ignore-scripts
$env:REMODEX_RELAY = 'wss://YOUR_RELAY_DOMAIN/relay'
remodex up
```

`npm link` exposes this checkout as `remodex`; it does not install the upstream
npm package. You can omit that step and use `node bin/remodex.js COMMAND` instead.
Keep the checkout at a stable path. If it moves or Node/Codex is reinstalled,
run `remodex start` again with `REMODEX_CODEX_BIN` pointing to the new binary.
An explicit binary override must be an absolute `.exe` or `.cmd` path; native
executables are preferred. Paths containing quotes, newlines or `%` are rejected.

`up` installs a current-user logon task, starts the bridge in a hidden window,
and prints a QR code. Closing the terminal does not stop it. The task runs at
ordinary user privileges; no Windows password is stored. The relay URL,
resolved executable paths and optional `CODEX_HOME` are stored in the user's
`.remodex` directory. Codex credentials remain in Codex's own storage. External
provider environment variables must also be available to that user's logon
session; terminal-only secrets are not copied into Remodex configuration.

```powershell
remodex status             # Task, heartbeat, relay and Codex launch state; log paths
remodex qr                 # Restart to issue a fresh short-lived pairing QR
remodex restart
remodex stop
remodex uninstall-service  # Remove logon task; keep trusted identity/configuration
```

`start` is idempotent. `reset-pairing` stops the service and clears trusted device
state; use it only when you intend to pair again. `qr --json` deliberately prints
private pairing material; do not share its output. Ordinary status and background
logs omit it. `run` remains a foreground mode; stop the scheduled service before
using it. Windows must stay awake and logged in; locking the screen is fine.

The task retries a crashed process up to three times, one minute apart. Network
reconnection is handled by the bridge. A bad configuration produces an error
and logs instead of an endless restart loop. `stop` verifies the recorded worker's
process creation time and executable before terminating its descendants.

## iPhone and GitHub Actions

Enable Actions on the fork if GitHub prompts you. Pushes to `main` or a manual
**Build Unsigned IPA** run produce the `remodex-unsigned-ipa` artifact containing:

- `remodex-unsigned-release.ipa`
- `remodex-unsigned-release.ipa.sha256`

Verify the checksum, then sign and install the IPA with your own sideloading tool.
It cannot be installed unsigned. The app requires iOS 18.6+, uses bundle ID
`io.github.hchris233.remodex`, and obtains the relay URL from the pairing QR.
No Apple signing secrets are needed in GitHub. Free-account signing may require
periodic refreshes according to your sideloading tool's rules.

Scan the QR inside Remodex. Check existing chats, create a task in a selected
project, send more than five messages, approve an action, interrupt a turn, and
reconnect after switching Wi-Fi/cellular or reopening the app. Local notification
delivery is subject to iOS background suspension; this build does not promise
APNs delivery while suspended.

## Update and recover

On Windows, stop the bridge, update this fork with `git pull --ff-only`, run
`npm.cmd ci --ignore-scripts` in `phodex-bridge`, then `remodex start`. Do not
replace the fork with `npm install -g remodex`. On the VPS, record the old commit,
pull the fork, and rerun the same Compose `up -d --build --wait` command.

For a failed update, check out the previously working commit and rebuild/restart
the same components. Do not delete `.remodex` or Caddy volumes. A relay restart
temporarily disconnects clients; saved device trust supports reconnection.

CI checks include Linux bridge/relay tests, Windows launch and real scheduled-task
checks, production container health, and a macOS Swift recovery harness plus IPA
archive validation. These do not replace your public-domain and real-iPhone checks.
