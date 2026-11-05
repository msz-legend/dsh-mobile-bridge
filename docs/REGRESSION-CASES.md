# 回归 Case 库 — dsh-mobile-bridge（可复用版）

> 用途：**DSH 桌面端每次升级后**，对移动 Web 端（dsh-mobile-bridge）做全功能回归。历史教训：宿主 UI 升级已连续引发 DMB-017/018/019 三轮 S1（侧栏 drawer 化、设置抽屉重构、层叠上下文陷阱），宿主升级后必跑本 Case 库。
> 首次制定：2026-11-05（R4，v0.5.0 基线）。Case ID 稳定递增，新增缺陷回归时按域追加编号。
> 配套产物：方案/报告 = `REGRESSION-PLAN-4.md` / `TEST-REPORT-4-REGRESSION.md`；可执行脚本 = `e2e/reg4-batch1..4-*.mjs`。

---

## 0. 环境准备（每次回归前）

1. **探测端口**（宿主 webServer 端口每次重启都变）：
   - 主进程 PID：`netstat -ano | grep LISTENING | grep 8787`（edge 固定 8787，同 PID 即宿主主进程）；
   - 宿主端口：在该 PID 的其他 LISTENING 端口中探测 `GET /plugins/dsh-mobile-bridge/status`（200 = 对）。
2. **配对 cookie**：复用 `baseline3/.device.json`（HttpOnly 设备令牌 + 宿主 owner cookie）。
   - 失效症状：页面 302 → `/pair`、插件样式/脚本全部缺失；
   - 重配：从宿主端口 `GET /pairing.json` 取码 → `POST /pair`（**打宿主端口，不打 edge**——edge 对配对限速 20/min，超限封 10min）→ 立即把 Set-Cookie 存回 `.device.json`；
   - 设备名额满（5/5）：`POST /devices/revoke {deviceId}`（宿主端口，loopback）撤销废弃测试设备。
3. **Playwright**：本机无 npm 安装，`await import('file:///<playwright安装目录>/node_modules/playwright/index.mjs')` + 系统 Chrome `C:/Program Files/Google/Chrome/Application/chrome.exe`；移动上下文 360×740、`isMobile:true, hasTouch:true`、Android UA；cookie 注入 domain=127.0.0.1。

## 1. Case 总表（26 条）

| 域 | ID | 功能 | P | 自动化要点 |
|---|---|---|---|---|
| 接入 | ACC-01 | 手机经 edge 加载完整 Web UI | P0 | 检查 composer(`[data-composer-input]`)、`_frame`、`_sidebarCol`、`_newSession` 均在位 + 0 pageerror |
| 接入 | ACC-02 | 未配对 → 跳配对页（fail-closed） | P0 | 无 cookie 新上下文 GET / → 断言落在 pair 页 |
| 接入 | ACC-03 | 配对页渲染质量 | P1 | 无码引导文案存在；无「剩余 0:00」矛盾态；`<html lang>` 有值 |
| 接入 | ACC-04 | 已配对免登录 | P0 | 复用 cookie 直接进 UI，不重配对 |
| 会话 | SES-01 | 窄屏侧栏浮层开/关 + scrim | P0 | 初始 collapsed+无 scrim → 点「打开侧边栏」(26,25) → open=1+scrim=block → 点 (350,400) → 收起+无残留 |
| 会话 | SES-02 | 切换会话 | P0 | **真实坐标点击**会话行（JS dispatchEvent 不触发宿主 handler）→ 主内容 `_titleRow` 变化 + 侧栏自动收起 |
| 会话 | SES-03 | 新建会话 | P0 | 点 `_newSession` → composer 就绪 |
| 会话 | SES-04 | 发送 → 流式 → 停止 | P0 | 真实键盘输入（execCommand 不触发宿主 onChange）→ 发送键启用 → 点击 → 停止键出现 → 点击 → 「已停止」终态 + 发送键恢复 |
| 会话 | SES-05 | 点会话不自动弹键盘 | P1 | 点会话前后 `document.activeElement` 均非 composer |
| 会话 | SES-06 | 主内容点击 no-op | P0 | 点 (180,400) 前后侧栏状态不变；elementFromPoint 命中真实内容而非 dmb-scrim |
| 审批 | APR-01 | 审批卡渲染（三键） | P0 | Playwright route 拦截 `**/events*` 返回 SSE 载荷（type:approval, requestId/risk/pattern/expiresAt）→ `.dmb-card` 出现，按钮 = 拒绝/始终允许/仅本次 |
| 审批 | APR-02 | 决策回传 | P0 | 点「拒绝」→ 捕获 POST `/decision` body 含 `{requestId, decision:reject}` |
| 审批 | APR-03 | always 规则记录 | P1 | 决策后 `status.rules` 增加指纹条目（本轮未跑，方法同 R1） |
| 审批 | APR-04 | 过期卡终态 fail-closed | P1 | 注入 `expiresAt: Date.now()-1000` 载荷 → 过期终态可感知（⚠️ SSE mock 一次性 body 有局限，自动断言易假阴性，建议真机走查兜底） |
| 设置 | SET-01 | 设置入口可达 | P0 | 展开侧栏 → 底部头像（`_5Qcc8a_avatar` 的 BUTTON 祖先）→ 菜单「设置」 |
| 设置 | SET-02 | 窄屏两级导航 | P0 | `[data-dmb-settings]` 打标 + mode=list；navCell 纵排且全部 x>0（横向溢出=DMB-019 回归）→ 点「手机桥接」→ mode=detail + `.dmb-nav-back` 可见 + 内容含「已配对设备」 |
| 设置 | SET-03 | 手机桥接详情/设备管理 | P1 | 详情状态卡片字段齐全；设备列表/生成配对码**仅 loopback 可见**（经 edge 时提示文案属预期） |
| 设置 | SET-04 | status 接口 | P1 | GET status：devices/online/rules/config/edge.listening 全部正确 |
| 体验 | UX-01 | 「› 展开」提示三态 | P1 | ⚠️ drawer 布局下收起态无可见 rail，提示已失效（DMB-017 遗留设计决策：删除或重设计）；宿主若恢复细条 rail 则恢复此 Case |
| 体验 | UX-02 | 触屏按压反馈 | P1 | **page.mouse.down()/up() 真实按压**（dispatchEvent 不触发 :active）→ filter 变 brightness(0.86) |
| 体验 | UX-03 | 提问卡片窄屏铺满 | P1 | 样式表含 `.wnLwla_frame` 规则；注入空 frame 宽 ≥360 |
| 体验 | UX-04 | PWA 元数据 | P2 | viewport / theme-color×2（带 media）/ manifest / apple-touch-icon（**等 networkidle 再断言**，meta 是异步注入的） |
| 稳定 | STB-01 | 固定域名可达 | P0 | GET publicBase/status → 200/302/401 均算通（401=隧道连通但需鉴权）；530/超时=失败 |
| 稳定 | STB-02 | 桌面 1440 无副作用 | P0 | narrow=空、scrim=none、hint=none、0 pageerror；⚠️ 已知 S4：桌面残留 `data-dmb-overlay` 属性（无视觉影响） |
| 稳定 | STB-03 | 门禁 | P0 | `npm run check` + `npm test` 全绿 |

## 2. 执行批次（与脚本对应）

| 批次 | 脚本 | 覆盖 |
|---|---|---|
| batch1 | `e2e/reg4-batch1-access.mjs` | STB-01 + ACC-01..04 |
| batch2 | `e2e/reg4-batch2-sessions.mjs` | SES-01..06 + pageerror 探针 |
| batch3 | `e2e/reg4-batch3-approval-settings.mjs` | APR-01/02/04 + SET-01..04 |
| batch4 | `e2e/reg4-batch4-ux-stability.mjs` | UX-01..04 + STB-02 |

复跑：`node e2e/reg4-batch1-access.mjs`（依序 4 个脚本；产出 JSON 行 + `baseline3/reg4-*.png` 证据截图）。
手工补充项：SES-04（脚本用 insertText 不生效，需真实键盘输入路径）、UX-02（同前）、APR-03。

## 3. 通过标准

- 全部 P0 通过；P1/P2 失败列出但不阻塞（需归因：缺陷 / 宿主行为变化 / 测试方法问题）。
- 无 pageerror 刷屏、无横向溢出、无浮层残留。
- 新增缺陷按 `DEFECTS.md` 的 DMB-### 格式登记，附复现命令与证据路径。

## 4. 明确不做（每次声明一次）

- 真机项（软键盘、手势条安全区、桌面版网站模式、Android 物理返回）：Playwright 覆盖不了，留用户真机走查。
- 真实工具审批闭环（宿主真发 approval/request）：APR 域用 SSE 注入模拟，与 R1/R3 同口径。
- Tailscale/Cloudflare 服务安装类一键操作：系统级变更只读探测。
- 常规新配对流程压测：edge 限速（20/min、封 10min），只在 cookie 失效时按 §0.2 重配一次。

## 5. 踩坑备忘（每条都真实咬过一次）

1. **几何判定会被 drawer 化击穿**：收起态元素保留全尺寸只平移出视口 → 宽度判定恒真。优先用宿主状态属性（`data-sidebar-collapsed`），几何兜底必须加「在视口内 (x≥-10)」。
2. **层叠上下文陷阱**：宿主容器自带 transform+小 z-index（如 71）会把后代的大 z-index（1050）困住——body 直属 scrim(1049) 反而盖住侧栏。诊断靠 elementFromPoint 而非看 z-index 数值。
3. **合成事件不可信**：`dispatchEvent(click/pointerdown)` 不触发 `:active`、也常不触发宿主 React handler；交互断言一律用真实坐标 `page.mouse.*`。
4. **宿主表单受控组件**：`document.execCommand('insertText')` 不触发 React onChange（发送键保持 disabled）；用 `page.keyboard.type`。
5. **panel 直接子元素清单是结构漂移的第一信号**：宿主重构抽屉时先 dump children 类名（`_content` 消失、navList 横排都是这么发现的）。
6. **异步注入的 head 元素**：PWA meta 等 networkidle 后再查。
7. **配对链路三重限流**：edge 20/min+10min 封禁、码一次性 3 次尝试、设备上限 5——测试用 cookie 务必存盘复用，重配走宿主端口。
