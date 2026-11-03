# DSH Mobile Bridge

> 用手机浏览器安全接入本机的 **DSH Desktop** —— 扫码即用，复用同一套 Web UI。

DSH Desktop 的 Web 界面只监听 `127.0.0.1`，手机无法直接访问。本插件在两者之间加一道**边缘网关**：
手机通过它加载的仍然是桌面上那份 Web UI（同源 WebSocket、同源 RPC、流式输出全部原样复用），
因此不需要重建任何前端，也不会出现「移动端功能残缺」的问题。

---

## 功能

- **扫码配对，长期免登录**：桌面生成 6 位一次性配对码 / 二维码，手机扫码后拿到长期设备令牌
  （HttpOnly Cookie），之后打开即用，无需反复登录。
- **完整复用桌面 Web UI**：会话列表、新建会话、发送与流式输出、停止输出、模型与推理等级选择、
  插件管理、文件预览、终端、浏览器等，全部与桌面一致，插件不重写界面。
- **工具审批搬到手机**：宿主发起工具调用审批时，手机弹出审批卡片，可选
  **仅本次 / 始终允许 / 拒绝**；「始终允许」按工具名与参数指纹记忆，同类请求不再打扰。
- **设备级访问控制**：每台手机一个独立令牌，可单独撤销；默认最多 5 台设备。
- **多档外网接入**：cloudflared 临时隧道（零账号、自带 HTTPS）、Tailscale（仅自己设备可见）、
  局域网直连，按需切换。
- **移动端适配**：注入 viewport / 安全区 / polyfill，支持「添加到主屏幕」全屏运行，
  并把桌面端 hover 才出现的控件（复制、关闭标签）在触屏上常显。
- **零配置接入**：网关在反代时自动改写 `Host` / `Origin`，无需修改 DSH 源码或信任配置。

## 要解决的问题

1. **手机访问不到桌面**：DSH Desktop 的 Web 载体硬编码监听 `127.0.0.1`，手机与电脑不在同一进程、
   也常常不在同一网络。插件在本机开一个边缘网关，把手机流量反代给宿主。
2. **手机端没有审批通路**：宿主的审批是进程内的 `approval/request` 事件，手机侧无处作答。
   插件作为该事件的监听器，把请求转成手机卡片、把决策回传宿主，超时与离线一律 fail closed。
3. **不想维护第二套前端**：很多「手机版」方案要重写界面，功能必然滞后。本插件让手机直接加载
   桌面同一份 Web UI，能力天然对齐，升级零成本。
4. **公网暴露的安全边界**：把本机能力暴露到公网必须是可控的。插件用「设备令牌闸门 + 一次性配对码 +
   可选桌面确认 + 按真实访客 IP 限速」四层防线，把风险收敛到「只有扫码配对过的设备能进来」。

## 接入方式

### 1. 安装插件

把本目录作为 bundle 安装到 DSH Desktop：

```sh
# 在 DSH 中安装本地 bundle（target 填本目录绝对路径）
plugin_manager action=install_bundle target=<本目录绝对路径>
```

或手工写进 profile 的 `dependencies`（`link:<本目录>`）与 `dsh.profile.bundles`，然后重启 Desktop。

依赖仅一个：`qrcode`（生成配对二维码；缺失时自动降级为「地址 + 配对码」文本）。

### 2. 选择访问通道

| 通道 | 适用场景 | 做法 |
|---|---|---|
| **cloudflared（公网，推荐）** | 手机不在同一局域网 | `winget install Cloudflare.cloudflared`，配置 `tunnelEnabled: true`，重启 Desktop 自动生成 `https://<random>.trycloudflare.com` |
| **Tailscale（隐私优先）** | 只有自己的设备要访问 | 两端登录同一 tailnet，`tailscale serve --bg http://127.0.0.1:8787` |
| **局域网直连** | 手机与电脑同网段 | 把 `edgeHost` 设为本机 LAN IP，手机访问 `http://<LAN IP>:8787` |

`publicBase` 优先级：显式配置 → cloudflared quick tunnel → Tailscale DNS → LAN 地址 → loopback。

### 3. 配对

1. 桌面打开 `http://127.0.0.1:<端口>/plugins/dsh-mobile-bridge/pair`，或从
   **设置 → 手机桥接** 点「生成配对码」，得到 6 位码与二维码（5 分钟有效）。
2. 手机扫码或输入配对码。
3. 配对成功后手机自动进入 Web UI，之后打开同一地址即可直接使用。

配对码限制：5 分钟一次性、同码最多 3 次尝试、按访客 IP 每分钟 20 次限速、默认最多 5 台设备。

> **免确认模式**：默认情况下，手机来源的配对需要桌面点一次「允许」才算完成（多一层「人在电脑前」的
> 保障）。若追求「扫码即通过」，在配置里打开 `autoApprovePairing: true`，配对码校验通过后直接发放
> 设备令牌，桌面不再弹确认卡片；配对码本身的时效与限次防护仍然生效。

### 4. 常用配置

```yaml
- id: dsh-mobile-bridge
  name: 'dsh-mobile-bridge'
  config:
    enabled: true
    edgePort: 8787          # 边缘网关端口
    edgeHost: '127.0.0.1'   # 写 'auto' 自动选 LAN IP + loopback
    tunnelEnabled: true     # 打开 cloudflared 隧道
    tunnelMode: 'quick'     # quick=临时地址；token=固定域名
    autoApprovePairing: false
    maxDevices: 5
```

### 5. 撤销与查看

**桌面端图形界面**：DSH 设置 →「手机桥接」里直接「设备管理」——列出所有已绑定设备（名称、在线/离线、绑定时间、最近活跃），可逐台「撤销」、一键「全部撤销」，或「清除已撤销记录」清理历史旧设备。撤销即时生效，已连接的手机立刻断开、令牌作废，需重新配对。

命令行 / 脚本同样可用（均 loopback-only，仅本机可调）：

```sh
# 查看设备与在线状态（仅本机可读）
curl http://127.0.0.1:<端口>/plugins/dsh-mobile-bridge/devices.json

# 撤销某台设备（立即生效）
curl -X POST -H 'content-type: application/json' \
  -d '{"deviceId":"dev_xxx"}' \
  http://127.0.0.1:<端口>/plugins/dsh-mobile-bridge/devices/revoke

# 撤销全部设备
curl -X POST http://127.0.0.1:<端口>/plugins/dsh-mobile-bridge/devices/revoke-all

# 清除已撤销的历史记录
curl -X POST http://127.0.0.1:<端口>/plugins/dsh-mobile-bridge/devices/purge
```

### 6. 稳定公网入口（解决「重启后 Cloudflare 报错 / 旧截图失效」）

quick 隧道的 `https://<随机>.trycloudflare.com` **每次重启都会变**：手机收藏/PWA 里的旧地址会指向已失效的隧道 → 刷新就看到 Cloudflare 1033/530「连不上」页面，旧配对二维码/截图也随之失效。

要让「地址固定、截图长期可扫」，需要一个稳定域名。按是否有账号，二选一：

**A. Tailscale（推荐，免费，无需 Cloudflare）** —— 固定 `https://<机器>.<tailnet>.ts.net`

1. 电脑安装并登录 Tailscale（免费个人版）：`winget install Tailscale.Tailscale`，然后 `tailscale up` 完成登录。
2. 公网访问（手机免装 App）用 Funnel：`tailscale funnel --bg 8787`（首次需在 Tailscale 管理后台开启 Funnel）；仅自己设备用 `tailscale serve --bg 8787`。
3. 插件会自动识别该 `*.ts.net` 地址作为 publicBase（`lib/tunnel.js` 的 `detectTailscale()`），无需改配置；地址永久固定 → 二维码/截图长期有效。

**B. Cloudflare 命名隧道（有 Cloudflare 账号 + 域名时，可选）**

1. Zero Trust → Networks → Tunnels → 新建隧道（cloudflared），复制**连接器 token**；添加 Public Hostname：`dsh.example.com` → `http://127.0.0.1:8787`。
2. 本机写机密文件（token 绝不进仓库），权限 0600：`C:\Users\<你>\.dsh\dsh-mobile-bridge\tunnel.json`
   ```json
   { "token": "<命名隧道连接器 token>", "publicBase": "https://dsh.example.com" }
   ```
3. 配置 `tunnelEnabled: true`、`tunnelMode: 'token'`（`tunnelToken`/`publicBase` 留空会自动读上面的文件），重启 Desktop。

稳定性：插件会对 quick 隧道做**健康探测**——进程还活着但隧道已死（边缘 1033）时连续失败 3 次即自动重启 cloudflared（叠加指数退避自愈）。

> 安全：固定域名让「截图长期可扫」，但**首次接新设备仍需桌面签发配对码**；已配对设备靠设备 Cookie 持续在线。敏感 token 只放本地文件（0600），勿提交 git。

## 安全说明

- 经设备令牌进入的浏览器与桌面同属 **owner** 权限，因此**把通道暴露到公网约等于 owner 级远程操作能力**，
  请务必只让自己配对。
- 防线依次为：设备令牌闸门（未配对请求不转发给宿主）→ 配对码仅桌面端可见且限次作废 → 可选桌面确认
  → 按真实访客 IP 限速熔断。隧道地址随机但公开可达，**真正的边界是设备令牌**。
- 局域网 HTTP 档下 cookie 在途不加密；cloudflared / Tailscale 档公网段全程 TLS，本机到网关仍是本机内明文。
- 所有响应附加 `nosniff` / `no-referrer` / `SAMEORIGIN` 等安全头。

## 目录结构

```
index.js               Host 入口（装配与生命周期）
client.js              浏览器半身（审批卡 + 事件流）
lib/edge.js            边缘网关（反代 / WebSocket 透传 / 令牌闸门 / 限速）
lib/approval-bridge.js 审批桥接（把宿主审批转成手机卡片并回传决策）
lib/pairing.js         配对码与设备令牌
lib/routes.js          配对页 / 事件流 / 决策 / 状态路由
lib/host-login.js      宿主登录交换与 cookie 续期
lib/cloudflared.js     隧道管理（quick / token、自动重启）
lib/tunnel.js          对外地址探测
lib/index-inject.js    移动端注入（viewport / polyfill / PWA）
```

## License

**MIT** —— 可自由使用、修改与分发，保留版权与许可声明即可。

---

如果这个项目帮到了你，欢迎在仓库点一个 ⭐ **Star**，这是对作者最直接的鼓励。
