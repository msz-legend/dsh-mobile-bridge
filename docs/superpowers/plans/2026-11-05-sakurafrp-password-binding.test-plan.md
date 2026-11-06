# 测试方案：SakuraFrp 免费穿透 + 密码绑定 + 改名「手机分身」

配套开发方案：[2026-11-05-sakurafrp-password-binding.md](./2026-11-05-sakurafrp-password-binding.md)

## 1. 测试目标与约束

- 证明 5 项改造全部生效，且**没有破坏**已安装实例的既有契约（内部 id、`BASE`、`dmb` cookie、PWA、devices 端点、rail CSS）。
- 约束：`node:test` + `node:assert`（现有仓风格）；**零新增依赖**；测试不依赖网络（frpc/cloudflared 用假二进制或 stub）；不实际启动 Chrome。
- 门槛：`npm run check` 与 `npm test` 全绿才算完成；每个任务先写红测试。

## 2. 分层策略

| 层 | 对象 | 方式 | 文件 |
|---|---|---|---|
| L1 单元 | binding / sakurafrp(core) / tunnel.resolve | 纯函数 + 假 FS 目录 | `test/binding.test.mjs`、`test/sakurafrp.test.mjs`、`test/tunnel-resolve.test.mjs` |
| L2 集成 | routes（HTTP 服务包 handler） | `node:http` 起临时 server，真实 fetch | `test/pair-password.test.mjs`、`test/sakura-routes.test.mjs`、`test/device-management.test.mjs`（回归） |
| L3 契约（静态断言） | client.js / routes.js / edge.js 文本 | 正则断言关键符号存在/消失 | `test/routes-security.test.mjs`、`test/qcard-css.test.mjs`、`test/body-limit.test.mjs`（回归） |
| L4 冒烟 | 真实桌面 + 真机 | 手动（见 §6） | — |

## 3. 用例明细

### 3.1 `test/binding.test.mjs`（Task 1）
在临时目录（`fs.mkdtempSync`）跑，不触碰真实 storeDir。
- B1 首次 `ensure()` 生成密码：长度=12、字符集 base64url、`binding.json` 存在、JSON 含 `{password,custom:false,createdAt}`。
- B2 权限：非 Windows 断言 `(mode & 0o077) === 0`；Windows 仅断言文件可读（chmod 无意义的平台差异在测试内分支）。
- B3 `ensure()` 二次调用幂等（密码不变、无重写时间戳变化）。
- B4 `verify(正确)` → true；`verify('错的')` → false；`verify('')` → false；`verify(null)` → false；`verify(正确+'  ')`（尾随空白）→ true（trim 生效）。
- B5 `regenerate()` → 新密码 ≠ 旧密码、`custom:false`、落盘生效。
- B6 `regenerate('my-secret-pass')` → `custom:true`、`verify('my-secret-pass')`→true、旧密码失效。
- B7 `regenerate('12345')`（5 位 <6）→ throws `'binding-password-length'`；`regenerate('x'.repeat(65))` → 同 throws。
- B8 `describe()` 不含密码本体，仅 `{hasCustom,createdAt}`。
- B9 注入 `randomPassword` stub 便于确定性断言（构造参数可选）。

### 3.2 `test/sakurafrp.test.mjs`（Task 3）
- S1 `parseFrpcUrl` fixture（Review Focus 1）：
  - `"启动成功，访问地址：http://frp-abc123.natfrp.cloud:45678\n"` → `http://frp-abc123.natfrp.cloud:45678`
  - `"隧道已启动: https://my-sub.frp-3.top\n"` → `https://my-sub.frp-3.top`
  - 裸 `"https://xxx.natfrp.cloud"` 出现在其它上下文 → 命中
  - `"frpc started, waiting..."`（无 URL）→ `undefined`
- S2 空 `sakuraToken` 或空 `sakuraTunnelId` → `start()` rejects/throws `'tunnelMode=sakura requires sakuraToken and sakuraTunnelId'`。
- S3 `config.tunnelMode='quick'` 时 `start()` no-op：`status().enabled===false`、`running===false`。
- S4 假 frpc：写一个临时 `fake-frpc.mjs`（`console.log('访问地址：http://fake-test.natprp.cloud:1234')` 后 `setTimeout 60s`），`config.sakuraBin=process.execPath` + 通过参数不可行 → 改为把 `fake-frpc.mjs` 作为 bin（`chmod +x` 在 Windows 用 `.cmd`/直接 node 包装）——**实现约定**：createSakuraFrp 支持 `bin` + `binArgs`（默认 `[]`），测试传 `bin=process.execPath, binArgs=[fakeScript]`，生产传 bin=frpc、binArgs=[]。S4 断言：start 后 ≤3s `onUrl` 收到 `http://fake-test.natprp.cloud:1234`、`status().running===true`；`stop()` 后 ≤3s `running===false`、子进程已退出。
- S5 健康探测：注入 `probe: async()=>false`、`healthIntervalMs:20`、`healthFailLimit:2` → 触发 kill 与重启计数 `restarts>=1`（用短超时，测试内 `await sleep`）。
- S6 `detectSakuraBin`：bin 不存在 → `{installed:false}`；存在（用 process.execPath）→ `{installed:true}`。

### 3.3 `test/tunnel-resolve.test.mjs`（Task 4 追加）
- T1 既有：`publicBase` 显式优先；https 隧道 URL 命中；`parseTunnelUrl` 用例不回归。
- T2 **新增**：`resolvePublicBase({publicBase:''},8787,[],log,'http://frp-x.natfrp.cloud:1234')` → `'http://frp-x.natfrp.cloud:1234'`（http 放宽生效）。
- T3 反例：`'ftp://x'` 或 `'not-a-url'` → 不返回隧道值（继续降级到 loopback）。

### 3.4 `test/pair-password.test.mjs`（Task 6，核心）
用临时 storeDir + 真实 http server 包 registerRoutes handler，deps 提供真实 `binding`（stub 密码 'test-pass-123'）、真实 `pairing`、stub `hub/bridge/always/tunnel/hostLogin/notify`，`rebuildTunnel` stub。
- P1 **正确密码 + 非 loopback 头**（`x-dmb-forwarded-for: 1.2.3.4` + `x-dmb-proto: http`）POST /pair `password=test-pass-123&name=phone` → 303、`location:'/'`、`set-cookie` 含 `dmb=`，且 **hub 未收到任何 `pair-request`**、**notify 未被调用**（Review Focus：去自动同意与去桌面确认的断言）。
- P2 错误密码 → 403，body 含错误文案（zh '密码不正确'），无 set-cookie dmb。
- P3 空密码 → 403。
- P4 频率限制：同一来源连续错 11 次 → 第 11 次 429（`perMinute=10`）；随后正确密码仍 429（窗口未过）——用注入 now 推进窗口后恢复 200/303。
- P5 loopback 直发：`x-dmb-forwarded-for` 缺省 + remoteAddress 127.0.0.1 → 正确密码 303（无确认弹窗）。
- P6 `GET /pairing.json`：loopback → 200 含 `password:'test-pass-123'`、`pairUrl`、`qrDataUrl`，且 **不含 `code` 字段**；非 loopback 头 → 403 `loopback-only`。
- P7 `GET /pair` 页面：body 不含 `requestSubmit`（内联自动提交脚本已删），表单含 `name="password"`；QR `img` 的 `src` 解码后 URL **不含 `#`**（dataURL 无法直接断言 → 改为断言页面不含 `#` 传码的 script + `/pairing.json` 返回的 `pairUrl` 末尾无 `#`）。
- P8 已删路由：`GET /pair/state?confirmId=x` → 404；`POST /devices/confirm` → 404。
- P9 设备上限：`config.maxDevices=1` 已有 1 台 → 正确密码 → 429 limit 文案（复用现有 limitText）。

### 3.5 `test/sakura-routes.test.mjs`（Task 6）
- R1 `GET /sakura.json` loopback → 200，字段齐全（`hasKey/hasTunnelId/customDomain/running/...`），初始 `mode` 反映 config。
- R2 `POST /sakura/setup` 缺 token → 400 `'sakura-token-required'`；缺 tunnelId → 400 `'sakura-tunnelid-required'`。
- R3 `domainChoice:'custom'` + `domain:'not-a-url'` → 400 `'sakura-domain-invalid'`。
- R4 成功（auto）：写 tunnel.json **保留既有 `{token,publicBase,serviceManaged}` 键**（Review Focus 5 向后兼容），新增 `sakura:{token,tunnelId,domain:''}`；config.tunnelMode==='sakura'、sakuraToken/sakuraTunnelId 已设；`rebuildTunnel` 被调用一次。
- R5 成功（custom）：`setPublicBase` 收到 domain 值；tunnel.json `sakura.domain` 落盘。
- R6 `POST /sakura/clear`：tunnel.json 的 `sakura` 键删除、`token/publicBase` 保留；config.tunnelMode==='quick'；rebuildTunnel 调用。
- R7 非 loopback 头访问 `/sakura.json`、`/sakura/setup`、`/sakura/clear` → 403 `loopback-only`。
- R8 deps 未传 `rebuildTunnel`（undefined）→ `/sakura/setup` 503（仿 notify 段容错）。

### 3.6 回归（必须全绿）
- `test/device-management.test.mjs`：devices.json / revoke / purge / revoke-all / client.js 引用（devicesTitle、devicesLoadError）不变。
- `test/qcard-css.test.mjs`：rail CSS 与 installRailOpenShortcut 不变。
- `test/routes-security.test.mjs`：requireLoopback 与 edge 302/x-dmb-forwarded-for 注入文本不变。
- `test/merge-cookie.test.mjs`、`test/edge-relogin.test.mjs`、`test/integration-edge.mjs`、`test/body-limit.test.mjs`、`test/approval-bridge.test.mjs`、`test/always-fingerprint.test.mjs`、`test/push.test.mjs`、`test/tailscale.test.mjs`、`test/cloudflare-setup.test.mjs`、`test/cloudflared.test.mjs`、`test/tunnel-health.test.mjs`、`test/soak.mjs` 全部不改即应通过；任何失败都按「回归」处理，先查是否触碰了不该碰的契约。
- 删除项：`test/auto-approve.test.mjs`、`test/pairing-limits.test.mjs`、`test/pairing-confirm.test.mjs`（阶段机已不存在，功能由 pair-password.test.mjs 覆盖）。

### 3.7 静态契约新增（并入 pair-password 或独立）
- C1 client.js 含 `'手机分身'` 与 `bindTitle`；不含 `'pair-request'` 分支关键字（`pair-request-resolved`）、不含 `PairCard`。
- C2 client.js 含 `SakuraCard`、`sfTitle`、`tsNote`。
- C3 routes.js 不含 `confirmWaitPage(`、`stageConfirm(`、`broadcastLoopback({ type: 'pair-request'`；含 `/sakura/setup`。
- C4 index.js 不含 `autoApprovePairing`、`pairingMaxAttempts`、`pairConfirmTtlMs`；含 `sakura`、`rebuildTunnel`。
- C5 locale/zh.json `meta.title==='手机分身'`；zh/en 均无 `pair.wait`。

## 4. 覆盖矩阵（需求 → 用例）

| 需求 | 关键用例 |
|---|---|
| ① SakuraFrp 集成 | S1-S6, R1-R8, T2 |
| ② 随机域名 + 手填域名 | S1（解析）, R4（auto）, R5（custom） |
| ③ Tailscale 保留 + 国外备注 | C2（tsNote）, `test/tailscale.test.mjs` 回归 |
| ④ 去扫码自动同意 + 密码绑定 | P1-P9, B1-B9, C3, C4 |
| ⑤ 改名「手机分身」 | C1, C5 |
| 无回归 | 3.6 全部 |

## 5. 执行与门禁

1. 任务内：`node --check <改动文件>` + 该任务测试 -> 绿。
2. 全部完成：`npm run check && npm test`。
3. 若某用例因平台（Windows chmod、进程信号）无法稳定：用**平台分支跳过 + 注释说明**，不得删除断言或放宽到无意义（禁止 `assert.ok(true)` 式占位）。
4. 任何「为了让测试过而改生产契约」的行为都要在该任务里显式记录到方案 Review Focus，并回问用户。

## 6. 手动冒烟（L4，需用户参与）

- M1 重装 bundle → DSH 设置面板出现「手机分身」，Plugin Manager 标题/描述为中文新文案。
- M2 BindingCard 显示 12 位密码、可复制、可重生成、可设自定义。
- M3 SakuraCard：不填密钥保存 → 提示 required；填真实 `访问密钥`+`隧道 ID`（需用户提供）→ frpc 启动、状态 running；日志为 `>>host:port<<` 或 `http(s)://节点地址` 时都能显示地址，绑定官方免费 `*.nyat.app` 子域（自动 HTTPS）时地址应为 https。
- M4 手机浏览器打开该地址 → 输入绑定密码 → 绑定成功进入 Web UI；**无**桌面确认弹窗、**无**扫码自动提交。
- M5 填自定义域名（CNAME 已配 + 自备 SSL）→ 地址切换为 https 自定义域。
- M6 Tailscale 卡片可见「⚠ 仅适合国外用户」备注。
- M7 老配置（tunnel.json 带 cloudflare token）升级后仍工作（不崩、地址不变）。

## 7. 风险与对策

- **frpc 输出格式漂移** → S1 fixture 驱动 + 解析失败提示手填域名（R3 兜底路径）。
- **http 明文降级安全** → 只放宽 publicBase 取值，不改 cookie Secure 判定（由 edge 的 x-dmb-proto 决定）；补 P1 断言 http 下 Set-Cookie **含** `dmb=` 且**不含** `; Secure`（明文场景不应假装安全），https 场景（x-dmb-proto:https）单独断言含 `; Secure`。
- **假 frpc 进程在 Windows 上难伪装** → 用 `bin=process.execPath + binArgs=[script]` 约定，避免 shell 与 shebang 差异。
- **频率限制测试时间依赖** → `createPairAttemptLimiter` 接受注入 `now`，测试推进虚拟时钟。
