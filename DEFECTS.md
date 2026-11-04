# DSH Mobile Bridge v0.4.7 缺陷清单

## R4-fix1（2026-11-05，用户真机反馈「点哪都开关侧栏，完全无法使用」）

### DMB-017：宿主侧栏改 drawer 布局后，展开判定恒真 → scrim 常驻、点击循环开关侧栏（S1）

- 级别：S1（移动端完全不可用）
- 现象：手机端（窄屏）页面加载后即被透明 scrim 盖住，点任意位置都会触发宿主侧栏 toggle —— 点一下打开、再点关闭，循环往复，无法正常操作任何功能。
- 根因：宿主 Web UI 升级后侧栏改为 drawer 布局（`_frame[data-sidebar-drawer]`）。**收起态**下 `_root`（`wtg9ga_root wtg9ga_quietBars`）宽度仍是 280px，只是 `sidebarCol` 被 `translate(-100%)` 平移出视口（x=-280）。`installSidebarState()` 用「侧栏根宽度 > 150px」判展开 → 收起态也测出 280px → 恒判「展开」→ `data-dmb-sidebar-open=1` + scrim 常驻；scrim 点击 → `collapseSidebar()` → 对收起态的 toggle 实际是「打开」，下一次点击又「关闭」，形成循环。
- 修复（client.js `installSidebarState`）：
  1. 检测 `_frame[data-sidebar-drawer]` 识别新布局；drawer 模式改用 `data-sidebar-collapsed` 属性判展开（无属性=展开），非 drawer 保留旧宽度判定；
  2. 兜底要求侧栏根在视口内（`x >= -10`）；
  3. 对 `_frame` 增补 `attributes` observer 监听 `data-sidebar-collapsed`，scrim 显隐不再慢一拍。
- 验证（Playwright 360×740 触屏 + Chrome CDP，`baseline3/fix4-*.png`）：
  - 初始加载：`sidebar-open` 无、scrim none、(180,400) 点到真实输入框 ✓
  - 点主内容区：侧栏状态不变 ✓
  - 点左上角「打开侧边栏」：展开（colX=0、collapsed=false、scrim block）✓
  - 点右缘 scrim：收起（colX=-280、scrim none）✓
  - 展开后点会话行：自动收起 ✓
  - `npm run check` + `npm test` 全绿。
- 生效：client.js → 刷新手机页面即生效（edge 现读磁盘）。
- 状态：已修复（2026-11-05）。

## R3-fix2（2026-11-04，用户真机反馈）

### DMB-016：「› 展开」提示浮在设置抽屉等全屏浮层之上

- 级别：S4（视觉瑕疵，无功能损伤）
- 现象：窄屏打开设置抽屉（全屏层）时，左下角「› 展开」提示仍浮在抽屉内容上（z-index 1040 > 抽屉层）。用户真机截图反馈。
- 根因：`installRailOpenShortcut` 的显示条件只判「rail 收起宽度 ≤90px + 键盘未弹起」，未判「rail 是否被浮层覆盖」。
- 修复：显示前用 `elementFromPoint(28, innerHeight-91)` 探测该位置最顶层元素，**只有仍属于 rail 列时才显示**；并补 `scroll`（capture）监听。任何现有/未来的全屏浮层（抽屉/提问卡/菜单）盖住 rail 时自动隐藏，无需逐层打补丁。
- 全浮层排查（`e2e/fix2-float-scan.mjs` + `fix2-float-scan2.mjs`，9 场景）：账号菜单/设置列表/设置详情/搜索浮层/侧栏展开/会话视图 → 隐藏 ✓；插件与自动化任务为**页内路由视图**（rail 未被覆盖，提示不遮挡内容，显示正确）；模型/访问模式下拉为局部弹层（与提示无重叠，显示正确）。**唯一泄漏点即设置抽屉，已闭环。**
- 验证：`e2e/fix2-rail-hint.mjs` 四场景（首页显示/抽屉隐藏/关闭恢复/侧栏展开隐藏）PASS；`npm run check` + `npm test` 全绿。
- 生效：client.js → 刷新页面即生效。
- 状态：已修复（2026-11-04）。

## R3 修复轮状态（2026-11-03）

> 完整说明见 [FIX-REPORT-R3.md](FIX-REPORT-R3.md)。

| 缺陷 | 修复 | 生效条件 | 验证 |
|---|---|---|---|
| DMB-010 暗色审批卡对比度 2.15/2.55:1 | 拒绝改实底红#dc2626+白字；pattern/摘要/计时器换暗色配对 | client.js → 刷新即生效 | 暗色卡 0 违例（原 3 条） |
| DMB-011 亮色卡头 1.99:1 | 卡头文字弃用 warn token，固定 #7c4a03，暗色媒体查询覆盖 | client.js → 刷新即生效 | 亮色卡头 0 违例 |
| DMB-012 无按压反馈/主操作<44px | .dmb-btn 44px；触屏 :active brightness(.86) | client.js 即时/index-inject 待重载 | CDP 真实输入 3/3 可用按钮生效 |
| DMB-013 配对页矛盾态/内部术语 | 无码引导 + 隐藏倒计时 + reason 友好文案 | routes.js → 待插件重载 | handler 渲染测试 13/13 PASS |
| DMB-014 locale 与 T 表脱节 | locale JSON 升级为配对页唯一文案源 | routes.js → 待插件重载 | 对齐校验 21/21 PASS |
| DMB-015 字号裁切/enterkeyhint/theme-color | composer 自适应+enterkeyhint+media theme-color+rail-hint 11px | client.js 即时/index-inject 待重载 | 注入单测 9/9 PASS |
| DMB-003 配对页硬编码 zh-CN | Accept-Language 协商 zh/en + 双语页面 | routes.js → 待插件重载 | en 请求 lang=en、可见文本无中文 |

宿主为 `link:` 加载：**client.js/index-inject 相关修复刷新页面即生效；routes.js/locale 需在插件管理器对 dsh-mobile-bridge 执行「重启/刷新」或重启 Desktop 后生效。**

## S1

（无）

## S2（R3 新增）

### DMB-010：暗色模式审批卡安全信息对比度 2.15:1 / 2.55:1（fallback 硬编码色未适配暗色）

- 级别：S2
- 用例：R3 STYLE-10/11（`e2e/contrast-audit.mjs`，SSE 注入卡片，载荷为 e2e 模拟数据）
- 现象：E3d 暗色下「拒绝」按钮文字 `rgb(185,28,28)` 配卡片底 `rgb(44,44,46)` = **2.15:1**；「将记住：…」always 范围预览 `rgb(15,118,110)` 同底 = **2.55:1**。正文 AA 要求 4.5:1。**产品的最安全操作（拒绝）与放行范围信息在暗色下接近不可读。**
- 根因指向：client.js `.dmb-btn.danger`、`.dmb-pattern` 使用硬编码 fallback 色（R1 已预警 24 处），未按宿主暗色主题切换。
- 证据：`baseline3/contrast-flags.json`、`contrast-E3d-card.png`
- 状态：未修复。

### DMB-011：亮色审批卡头「等待你的决定」对比度 1.99:1

- 级别：S2~S3
- 用例：R3 STYLE-10；13px 正文（需 4.5:1）
- 现象：amber `rgb(245,158,11)` 配 warn 头部底 `rgb(254,245,231)` = 1.99:1。
- 根因指向：宿主 `--dsw-alias-state-warn-primary/tertiary` token 前景/背景配对本身低对比（注入侧未做可读性补偿）。
- 证据：`baseline3/contrast-flags.json`、`contrast-E3-card.png`
- 状态：未修复。

## S2（既有）

（DMB-001 见下；DMB-005/006 已闭环）

## S3（R3 新增）

### DMB-012：全部可点元素无按压反馈；主操作触控目标 34–36px

- 级别：S3
- 用例：R3 UX-01/02（`e2e/ux-interaction.mjs`、`e2e/ux-approval-card.mjs`）
- 现象：审批三键 + 发送/新建会话/账号菜单/侧栏/composer 共 **10/10** 元素 pointerdown 后 60ms 内 computed style 零变化（无 active 态）；4 个主操作尺寸 34–36px，低于 44×44 实践标准（WCAG 2.5.8）与 R1 白名单的 ≥40px 线。
- 证据：`baseline3/ux-interaction.json`（pressed[].changed=false；undersizedPrimary）
- 状态：未修复。

### DMB-013：未配对落地页矛盾态文案「配对码已过期…剩余 0:00」+ 错误提示暴露内部术语 no-code

- 级别：S3
- 用例：R3 UX-04（`e2e/ux-states.mjs`，无 cookie 访问 `/` → 重定向配对页）
- 现象：首次来访（尚无配对码）即显示「配对码已过期，刷新页面获取新的。剩余有效期 0:00」——应为「请到桌面端生成配对码」类引导；提交错误码后提示「配对失败（no-code）」暴露内部状态名。
- 证据：`baseline3/ux-pair-en.png`、`ux-pair-wrongcode.png`、`ux-states.json`
- 状态：未修复。

### DMB-014：locale/*.json 与 client.js 内联 T 表完全脱节（双语覆盖空洞）

- 级别：S3
- 用例：R3 TEXT-11（`e2e/locale-check.mjs`）
- 现象：内联 T 表 93 键 vs locale/zh.json、en.json 各 18 键，**零交集**；实际文案由内联表驱动，locale 文件为死资产。zh/en JSON 内部一致（18 键互相对齐），但覆盖面与 T 表不成比例。
- 证据：`baseline3/locale-parity.json`
- 状态：未修复（与 DMB-003 一并处理建议：统一到单一 i18n 源）。

## S3（既有）

（DMB-002/003 见下；DMB-003 本轮复核**未修复**，见「待复测」）

## S4（R3 新增）

### DMB-015：系统字号放大 1.3x 时 composer 占位文本裁切 + 细节卫生四项

- 级别：S4
- 用例：R3 真机字号测试（`baseline3/device-d12-fontscale130.png`、`e2e/device-cdp-evidence.mjs`）
- 现象：① font_scale 1.3 时 composer 占位第二行被裁切一半（固定高度不自适应），工作区行「标准模式」文字被挤没；② 「› 展开」提示 10px 字号（低于 12px 辅助下限）且对比 3.71:1；③ composer 缺 `enterkeyhint="send"`；④ 两个 theme-color meta 均无 media 属性，暗色下状态栏色可能不跟随。
- 证据：`baseline3/device-d12-fontscale130.png`、`ux-a11y-extra.json`、`device-cdp-home.png`
- 状态：未修复。

## R3 复测/未复现登记

- DMB-003（配对页硬编码 zh-CN）：R3 复核**仍未修复**（`locale=en-US` 下全文中文 + `lang="zh-CN"`，`ux-pair-en.png`）。正面发现：宿主 UI 与 client.js 的 aria-label 均正确本地化，配对页是唯一孤岛。
- 断线提示条（UI-06/R3 UX-04）：`**/api/**` 502 注入 45s 未复现 banner；遗留真机飞行模式场景人工复测。
- 审批活体回传（FUNC-02/03）：本会话宿主审批档位禁用无法触发 waterfall；单测 13 checks + SSE 注入渲染与决策 POST（载荷正确）+ R1 真机决策回流证据共同覆盖；遗留活体验收项。
- 真机人工项：软键盘弹起时 composer 可见性、手势条安全区（PWA standalone）、桌面版网站模式（E6）、Android 物理返回。

## S1（历史，已闭环）

### DMB-009：外网手机 /api 请求持续 401（同名 owner cookie 未覆盖）

- 级别：S1
- 现象：手机经外网/隧道创建会话、上传排队任务时弹
  `client api: session/prompt failed: transport failure for /api/session/prompt: HTTP 401 (gateway/internal)`。
- 根因：宿主鉴权 `cookieValue` 只取 Cookie 头里**第一个**同名段；Desktop 重启后
  `hostLogin` 重新登录发的 owner cookie（`dsh-auth-<authority 哈希>`）与手机浏览器 jar 里
  留存的失效 cookie **同名**（webServer 端口不变时哈希相同）。`lib/host-login.js`
  `mergeCookieHeader` 旧实现把新 cookie 追加在旧 cookie **之后**，重放请求里宿主仍读到
  失效旧值 → 401 重登重放永远失败。端口变化时同名不冲突，故此前 LAN 测试未暴露。
- 证据（现网复现，旧代码）：同 jar 中把 owner cookie 值改成 `STALE_INVALID` 后
  `POST /api/session/list` 经 edge 返回 **401 unauthorized**；cookie 全新时返回 **200**。
- 修复：`mergeCookieHeader` 按名去重、新值覆盖旧值（不再追加重复段）；
  新增 `test/merge-cookie.test.mjs`（5 断言）、`test/edge-relogin.test.mjs`
  （完整 401→重登→重放链路，3 断言）。
- 状态：已修复（2026-11-02，单测 + 模拟宿主集成测试通过；需重启 Desktop 使宿主侧
  `lib/host-login.js` 生效）。

### DMB-007：图标按钮标记只打不撤，展开侧栏后被撑成 252×252 巨块

- 级别：S1
- 根因：`installIconButtonFix.mark()`（client.js）的候选集是 `button:not([data-dmb-icon])`，
  已打标按钮永不复查；初始收起 rail 上 36px 图标按钮被打 `data-dmb-icon` 后，
  展开侧栏按钮变 252px 宽，CSS `aspect-ratio:1/1` 把高度也撑到 252px，
  会话列表（regionArea flex:1）高度归 0 被挤出视口。
- 证据：360px 展开态 panelRow 252×252 / regionArea 高 0；禁用 `style[data-dsh-mobile-bridge]`
  后 panelRow 252×36、regionArea 高 482（probe/diag-sidebar3.mjs、diag-sidebar4.mjs）。
- 修复：mark() 增加反向遍历撤销过期标记 + document 捕获 click 后 120/520ms 延迟复查。
- 状态：已修复（2026-11-01 真机复测通过）。证据：展开态 panelRow 36px（Playwright）/39px（真机）、
  收起后 rail 图标恢复 36×36 并重新打标；详见 FIX-REPORT-3.md。

### DMB-008：侧栏浮层 100vmax scrim 不区分展开/收起态，主窗口永久蒙灰

- 级别：S1
- 根因：`html[data-dmb-narrow="1"] [class*="_root"][class*="_quietBars"]` 无条件加
  `position:fixed` + `box-shadow:0 0 0 100vmax rgba(0,0,0,.42)`；收起态 56px 细条
  也带全屏黑影，右侧主会话窗口永远灰蒙蒙。
- 证据：收起态 computed style `shadow: rgba(0,0,0,0.42) 0px 0px 0px 780px`、`w:56`、`pos:fixed`。
- 补充根因：宿主新版展开态侧栏根只剩 `_root`（`_quietBars`/`_collapsed` 被摘掉），
  `installNarrowFlag` 的展开判定永不命中，`data-dmb-sidebar` 恒缺；
  改由新增 `installSidebarState()` 维护 `data-dmb-sidebar-open` + `data-dmb-overlay`。
- 修复：CSS 拆分，收起态仅保留 overflow 约束；fixed + scrim 挂 `[data-dmb-overlay]`
  且 z-index 降为 1050（原 2147481900 会盖住宿主 z=1100 的账号菜单弹层）；
  另在设置抽屉 bind 成功时自动收起侧栏。
- 状态：已修复（2026-11-01 真机复测通过）。证据：收起态 rail static + box-shadow none
  （Playwright 与真机一致）；设置打开后浮层移除、抽屉 312px；详见 FIX-REPORT-3.md。

## S2

### DMB-001：超过 2 MiB 的请求体被静默转发为空体

- 级别：S2
- 用例：BODY-02
- 复现命令：`node test/integration-edge.mjs`
- 复现步骤：向 `http://127.0.0.1:8787/api/body-limit-probe` POST 3 MiB body；检查 `lib/edge.js` 的 body 缓冲与转发路径。
- 期望：明确返回 413，或完整转发并由宿主处理；不能静默丢弃附件体。
- 实际：`lib/edge.js:227-240` 将 overflow 后的 body 设为 `undefined`，`lib/edge.js:292-293` 调用 `upstreamRequest.end()` 空体转发。实时上游当前返回 401，无法从宿主业务接口读取 body receipt，但该分支的静默丢弃已由代码路径和 3 MiB 请求复现确认。
- 疑似根因：`lib/edge.js:237` 用 `undefined` 同时表达“超限”和“无 body”，缺少 413 分支。

## S3

### DMB-002：经 edge 访问插件资源时未观察到 no-cache 响应头（需确认鉴权分支）

- 级别：S3（当前证据不足以升级）
- 用例：INJ-02
- 复现命令：`node test/integration-edge.mjs`
- 期望：`/plugins/` 响应包含 `cache-control: no-cache`，包括未配对访问的插件端点。
- 实际：对 `GET http://127.0.0.1:8787/plugins/dsh-mobile-bridge/status` 观察到 `401` 且 `cache-control` 缺失；产品代码仅在代理到宿主的 `deliver()` 中设置 no-cache，未授权早退路径不设置。
- 疑似根因：`lib/edge.js:352-360` 的未授权响应没有复用 `pluginPath` 的缓存头逻辑；`lib/edge.js:273` 只覆盖 proxy deliver 分支。
- 限定：由于该请求未进入宿主代理，尚不能证明已配对插件资源会被浏览器缓存；建议后续用可用 cookie 重跑后决定是否保留 S3。

### DMB-003：配对页固定声明中文 locale

- 级别：S3
- 用例：TEXT-04
- 复现步骤：打开 `/plugins/dsh-mobile-bridge/pair`，检查 `<html lang>` 与英文浏览器环境；同样检查确认页。
- 期望：英文环境使用 `en-US` 或按实际文案语言声明；英文页面不保留中文 locale 声明。
- 实际：`lib/routes.js:89` 与 `lib/routes.js:137` 固定为 `lang="zh-CN"`，页面文案也固定中文。
- 疑似根因：`lib/routes.js:84-131`、`lib/routes.js:134-179` 使用硬编码 HTML，未接入 locale 或请求语言协商。

## S4

暂无。

## 待复测

- 当 active device 数量清理到 0–1 且不影响用户设备后，重跑全部 5 个 §6.8 环境；当前按约束未执行 revoke-all。
- 提供宿主 echo/测试 endpoint 后，补做 BODY-01/02 的“宿主实际收到完整 body”证据及 BODY-03。

### DMB-004：上一轮证据无效（设置未进入的原结论撤回）

- 上一轮7张截图同SHA，DOM click未能证明交互，不再作为有效缺陷。
- 本次ADB实测已完成 list → detail → list；03 content=360、返回箭头40x40，04 mode=list。原“无法进入设置”未复现。

### DMB-005：上一轮证据无效；本轮重新复现侧栏挤压

- 级别：S2；仅以下新证据有效。
- 状态：复测中。备注：Codex 测量与 CDP 复测结论冲突，疑为动画中间态，待真机复测裁决。
- 复测结果（2026-11-01）：由 DMB-007/DMB-008 的修复闭环。真机展开侧栏后会话列表可见
  （regionArea 314px）、收起后主内容无蒙层；grid 挤压场景随展开态改浮层 + 收列消失。
  证据：device-shots/fix3-sidebar-open.png、fix3-sidebar-collapsed.png，详见 FIX-REPORT-3.md。
- 步骤：关闭设置后，通过uiautomator获取“打开侧边栏”bounds=[30,296][138,404]，ADB tap(84,350)，等待1.6秒。
- 实际：gridTemplateColumns=280px 80px 0px；sidebarCol position=static；主内容80/360=22.22%；右侧文字逐字换行，发送按钮x=360超出视口。
- 期望：侧栏fixed覆盖层，主内容宽度至少324px。
- 证据：device-shots/05-sidebar-overlay.png，SHA 2a57361b2e0ba92c；对应XML和assertions.json。

### DMB-006：窄屏工具条及灰色遮罩覆盖设置/会话

- 级别：S2；本轮新增有效视觉证据。
- 步骤：ADB点账号菜单 → 设置 → 手机桥接 → 返回；分别截图。
- 实际：设置列表/详情的左缘文字和图标被左侧工具条覆盖，主区域有灰色遮罩；会话和输入区截图也有遮罩。
- 数值：设置详情contentWidth=360、返回箭头(8,8,40,40)，但数值全宽不能证明无遮挡。列表navWidth=312、x=24，其左缘也遭覆盖。
- 期望：活动设置层文字、图标完整可读；遮罩应位于活动层后方。
- 证据：02/03/04/07设置截图及01/06会话截图；03 SHA aa23e0744f1b1543、07 SHA 44468d83d4a34cd5。
- 根因未确认；不把视觉观察推断为特定CSS根因。
