# DSH Phone Mirror

<p align="center">
  <img src="icon.svg" width="72" alt="DSH Phone Mirror logo" />
</p>

> Use your phone's browser to securely reach your local **DSH Desktop** — bind by entering a password, reuse the exact same web UI.
>
> English | [中文](./README.md)

<p align="center">
  <img src="docs/screenshots/cover.png" width="300" alt="Remotely use DSH Desktop from your phone: password binding, streaming replies, tool approvals" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/demo.gif" width="220" alt="Demo: enter binding password → session list → streaming → tool approval → done" />
</p>

<p align="center">
  <sub><b>Phone</b> (reuses the exact desktop web UI)</sub><br/>
  <img src="docs/screenshots/06-m-pairing.png" width="180" alt="Enter the binding password on the phone" />
  <img src="docs/screenshots/07-m-streaming.png" width="180" alt="Streaming output on phone" />
  <img src="docs/screenshots/08-m-approval.png" width="180" alt="Tool approval card: allow once / always allow / reject" />
</p>

<p align="center">
  <sub><b>Desktop</b> (binding password · device management · fixed-domain access)</sub><br/>
  <img src="docs/screenshots/12-desktop-pairing-dialog.png" width="380" alt="View the binding password on desktop" />
  <img src="docs/screenshots/10-desktop-device-management.png" width="380" alt="Device management and revocation" />
  <br/>
  <img src="docs/screenshots/09-desktop-bridge-settings.png" width="380" alt="Phone Mirror settings panel" />
  <img src="docs/screenshots/11-desktop-fixed-domain.png" width="380" alt="Cloudflare fixed domain + run as service" />
</p>

<p align="center"><sub>More screenshots in <a href="docs/screenshots/">docs/screenshots/</a> (13 shots)</sub></p>

DSH Desktop's web UI only listens on `127.0.0.1`, so phones can't reach it. This plugin adds an **edge gateway** in between: your phone still loads the desktop's web UI (same-origin WebSocket / RPC, streaming output all untouched), so there is no "crippled mobile version" and no second frontend to maintain.

## Highlights

- **Bind by password, long-lived sessions** — the desktop **Settings → Phone Mirror** panel shows a binding password you can view, copy, regenerate or customize (6–64 chars). Open the address on your phone (the QR encodes only the address, **never the password**), type the password, and you are bound immediately with **no desktop confirmation popup** and **no scan-to-auto-bind**. The password is stored in a local `binding.json` (`0600`); afterwards your phone holds an HttpOnly device token and just works.
- **Full desktop UI on mobile** — sessions, streaming output, stop, model & reasoning level, plugins, file preview, terminal: all identical to desktop. Narrow-screen tweaks: overlay sidebar, auto-collapse, no auto keyboard, touch-always-visible controls, PWA "add to home screen".
- **Tool approvals on your phone** — when the agent needs a tool approval, a card pops up on your phone: *once / always / reject*. "Always" is remembered per tool + argument fingerprint. Fail-closed: timeouts and offline phones count as "not executed".
- **Five access lanes** — SakuraFrp free tunnel (recommended for mainland China), LAN direct, cloudflared quick tunnel (zero account), Tailscale (private, WireGuard-encrypted; ⚠️ **overseas users only** — login and relay are unstable on mainland China networks), Cloudflare named tunnel (your own fixed domain, two-click setup in the settings panel).
- **Always-on fixed address** — register the named tunnel as a Windows service so it survives reboots; a tunnel health watchdog auto-restarts dead tunnels with exponential backoff.
- **Device management** — list bound phones (online/offline), revoke one / all, purge history; each phone gets its own token (default max 5).

## Quick start

1. Install as a DSH Desktop bundle: `plugin_manager action=install_bundle target=<this directory>`, then restart Desktop. A cloudflared quick tunnel starts automatically — you are usable out of the box.
2. Desktop: **Settings → Phone Mirror** → view / copy / regenerate / customize the **binding password**. It is saved in a local `0600` `binding.json`, never uploaded.
3. Phone: open the address (or scan the address-only QR), **type the binding password** and submit. A correct password binds directly — **no desktop confirmation prompt**. Done — bookmark it or add to home screen.

> The quick tunnel URL is random and changes on restart. For a stable address use SakuraFrp (see below), Tailscale (private, overseas users only) or your own free domain + Cloudflare named tunnel — the full zero-cost walkthrough (DigitalPlat free domain → Cloudflare → named tunnel → Windows service) is in the [Chinese README §6](./README.md#六固定地址--稳定入口解决重启后-cloudflare-报错旧截图失效).

## SakuraFrp (recommended for mainland China)

Cloudflare quick tunnels and Tailscale are often unreliable on mainland China networks. The SakuraFrp (NATFrp) free tier is the easiest stable address there:

- **Free tier limits**: 2 tunnels, 5 GiB of traffic per month, 10 Mbps bandwidth. **Real-name verification is required** before you can create a tunnel.
- **Setup**: grab the access key from your SakuraFrp account page, create a tunnel and note its tunnel ID. Download `frpc` for your platform from <https://www.natfrp.com/tunnel/download> (`0.51.0-sakura-14` or newer recommended) and point `sakuraBin` at it (default `frpc`, resolved via PATH).
  - Per the [official docs](https://doc.natfrp.com/app/http.html), a **TCP tunnel** address must include the port, and a TCP tunnel carrying HTTP **must use a non-mainland node**. An **HTTP(S) tunnel** needs no port but **requires your own domain** (ICP-filed on mainland nodes).
  - Recommended: claim the free `*.nyat.app` subdomain + certificate via [subdomain binding](https://doc.natfrp.com/bestpractice/domain-bind.html) and enable frpc auto-HTTPS for an encrypted `https://<subdomain>:<port>` entry point.
- **Enable**: in Settings → Phone Mirror → SakuraFrp, choose Random domain or Custom domain, enter the access key and tunnel ID, and save. Equivalent config: `tunnelMode: 'sakura'`, `sakuraToken`, `sakuraTunnelId`. The plugin starts `frpc -f <access-key>:<tunnel-id>`. SakuraFrp is **off by default** — the default mode is still `'quick'`.
- **Random domain (auto-detected)**: leave `sakuraDomain` empty and the plugin reads the `frpc` log, supporting the official formats `使用 >>www.example.nyat.app:10086<< 连接你的隧道`, `或使用 IP 地址连接: >>114.51.4.191:10086<<` (IP fallback, domains win), and `http://cn-hk-nf-1.natfrp.cloud:51906` (plus `*.frp-*.com` / `*.frp-*.top` / `*.natfrp.cloud`). A `*.nyat.app` host, or a log line like `已从服务器为 … 加载证书` / auto-HTTPS, yields **https**; otherwise **http**.
- **Custom domain**: set `sakuraDomain` (e.g. `https://dsh.example.com:12345`) and add a **CNAME pointing at the tunnel node address**; you must also **bring your own SSL certificate** — the plugin does not issue certificates for you.

> ⚠️ **Security disclosure (read this)**: without the free `*.nyat.app` subdomain or frpc auto-HTTPS, SakuraFrp serves **plaintext HTTP — there is no TLS between the phone and the node**. The binding password, conversation content and tool-approval traffic all cross a public node in cleartext and can be read by the node operator or anyone on the path. For sensitive environments, bind the free subdomain to enable auto-HTTPS, use a **custom domain + your own SSL certificate**, or switch to an end-to-end encrypted lane such as **Tailscale** or a **Cloudflare named tunnel**. Do not treat the plaintext random subdomain as a long-term production entry point.

> ⚠️ **Tailscale — overseas users only**: Tailscale login and relay are unstable on mainland China networks. The private-network / Serve / Funnel lanes and the one-click wizard are kept in full, but mainland users should prefer SakuraFrp (with a custom domain + SSL or the free HTTPS subdomain) or a Cloudflare named tunnel.

## Security model

A bound browser has **owner-level power** over the machine. Exposing this to the internet ≈ giving yourself a remote shell; only bind your own devices. Defense in depth: device-token gate (unbound requests are never proxied to the host) → binding password (visible only on the desktop, regenerable, timing-safe comparison) → per-source-IP sliding-window rate limiting / circuit breaking → fail-closed approvals. The device token is the real boundary.

- **SakuraFrp free tier**: plaintext HTTP (**no TLS between the phone and the node**) unless you bind the free `*.nyat.app` subdomain or enable frpc auto-HTTPS. Use the free HTTPS subdomain / a custom domain + your own SSL certificate, or Tailscale / Cloudflare named tunnels for sensitive environments.
- **Tailscale / cloudflared named tunnels**: encrypted end to end. Tokens stay in a local `0600` file, never committed. ⚠️ Tailscale is **overseas users only** — login and relay are unstable on mainland China networks.
- **LAN HTTP**: cookies are unencrypted in transit; all responses carry `nosniff` / `no-referrer` / `SAMEORIGIN` headers.

## Configuration

All options are documented in the [Chinese README §4](./README.md#4-配置项). One dependency: `qrcode`. Requires Node ≥ 22 and DSH Desktop.

```yaml
- id: dsh-mobile-bridge
  name: 'dsh-mobile-bridge'
  config:
    enabled: true
    edgeHost: '127.0.0.1'
    edgePort: 8787
    publicBase: ''
    tunnelEnabled: true
    tunnelMode: 'quick'     # 'sakura' | 'token' | 'quick' (default 'quick'; sakura is opt-in)
    tunnelToken: ''
    tunnelBin: 'cloudflared'
    tunnelProtocol: ''      # use 'http2' when Cloudflare WARP is installed
    sakuraToken: ''         # SakuraFrp access key (secret, never commit)
    sakuraTunnelId: ''      # SakuraFrp tunnel ID
    sakuraBin: 'frpc'       # https://www.natfrp.com/tunnel/download
    sakuraDomain: ''        # empty = auto-detect >>host:port<< / node URLs (*.nyat.app, *.natfrp.cloud, frp-*.com|top) from frpc logs
    enableLan: true
    maxDevices: 5
    approvalTimeoutMs: 60000
    approvalTimeoutRemoteMs: 30000
    offlineGraceMs: 5000
    alwaysScope: 'session'  # session | global
    storeDir: ''
```

`tunnelMode` has three values: `'quick'` (default, zero-account cloudflared temporary address, changes on restart), `'token'` (Cloudflare named tunnel with your own domain and a local `tunnel.json`), `'sakura'` (SakuraFrp free tunnel, recommended for mainland China — read the plaintext-HTTP / auto-HTTPS warning above). Binding is a single password step with no desktop confirmation popup; the password stays valid until you regenerate it.

## Feedback

- 🐛 Bugs & feature requests: [Issues](https://github.com/msz-legend/dsh-mobile-bridge/issues)
- 💬 Discussions: [Discussions](https://github.com/msz-legend/dsh-mobile-bridge/discussions)

## License

MIT. If this project helps you, a ⭐ is the best encouragement.
