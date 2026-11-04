# 回归测试方案 — dsh-mobile-bridge v0.5.0（2026-11-05）

> 触发：DSH 桌面端升级导致移动 Web 端连续两轮 S1（DMB-017/018）。本轮以「宿主 UI 新版本（drawer 布局）」为基线做全功能回归。
> 环境：DSH Desktop 宿主 webServer 127.0.0.1:50491；edge 127.0.0.1:8787（LAN 192.168.0.110:8787）；publicBase https://dshmobile.dpdns.org（token 隧道，serviceManaged）；设备 5/5，在线 2。
> 工具：Playwright（系统 Chrome）360×740 触屏上下文（isMobile/hasTouch）经 edge 访问；配对 cookie 复用 baseline3/.device.json（edge 配对限速 20/min）。

## 一、被测功能面 → Case 映射

| 域 | Case ID | 功能（README §一） | 优先级 | 自动化方式 |
|---|---|---|---|---|
| 接入 | ACC-01 | 手机经 edge 加载完整 Web UI（同源复用桌面 UI） | P0 | Playwright 打开 / 检查宿主框架元素存在 |
| 接入 | ACC-02 | 未配对访问 → 跳配对页（fail-closed） | P0 | 无 cookie 新上下文访问 / |
| 接入 | ACC-03 | 配对页渲染（配对码引导/双语/无矛盾态） | P1 | GET /pair 快照（DMB-013/003 回归） |
| 接入 | ACC-04 | 已配对免登录（HttpOnly 设备令牌长期有效） | P0 | 复用 cookie 直接进 UI |
| 会话 | SES-01 | 会话列表展开/收起（窄屏侧栏浮层 + scrim） | P0 | DMB-017/018 回归脚本 |
| 会话 | SES-02 | 切换会话（点会话行 → 主内容切换 + 侧栏自动收起） | P0 | 主内容标题断言 |
| 会话 | SES-03 | 新建会话（侧栏「+ 新会话」入口） | P0 | 点击 + 主内容状态断言 |
| 会话 | SES-04 | 发送消息 → 流式输出 → 停止 | P0 | composer 输入 + 发送 + 停止键断言 |
| 会话 | SES-05 | 点会话不自动弹输入法（no-autofocus） | P1 | data-composer-input 焦点断言 |
| 会话 | SES-06 | 窄屏点主内容/遮罩不误触（scrim no-op 与命中） | P0 | elementFromPoint + 点击前后状态 |
| 审批 | APR-01 | 宿主审批事件 → 手机弹审批卡（once/always/reject 三键） | P0 | SSE 注入模拟（approval/request waterfall） |
| 审批 | APR-02 | once 决策回传宿主（POST 决策） | P0 | 注入后点按钮，断言决策 POST |
| 审批 | APR-03 | always 规则记录（session 域指纹） | P1 | 决策后 status.rules 变化 |
| 审批 | APR-04 | 审批卡倒计时/超时 fail-closed | P1 | 渲染断言（不真实等待 60s） |
| 设置 | SET-01 | 设置 → 手机桥接面板打开（桌面入口） | P0 | 账号菜单 → 设置 → 手机桥接 |
| 设置 | SET-02 | 窄屏设置两级导航（列表 → 详情 → 返回） | P0 | data-dmb-mode=list/detail 断言 |
| 设置 | SET-03 | 设备管理列表渲染（名称/在线状态/操作） | P1 | .dmb-device 数量与字段 |
| 设置 | SET-04 | 状态接口正确（status: devices/online/rules/config） | P1 | GET status JSON 校验 |
| 体验 | UX-01 | 「› 展开」提示：收起态显示、展开态隐藏、浮层盖住时隐藏 | P1 | DMB-016 回归 |
| 体验 | UX-02 | 触屏按压反馈（:active brightness） | P2 | computed style 差分 |
| 体验 | UX-03 | 提问卡片窄屏铺满（wnLwla 修复回归） | P1 | 注入卡片后宽度断言 |
| 体验 | UX-04 | PWA 元数据（viewport/theme-color media/manifest） | P2 | index-inject 静态断言 |
| 稳定 | STB-01 | 隧道固定域名可达（publicBase 200/302） | P0 | HTTPS GET dshmobile.dpdns.org |
| 稳定 | STB-02 | 桌面（1440）无副作用：无浮层残留/无 pageerror | P0 | 1440×900 上下文走查 |
| 稳定 | STB-03 | 单测/语法门禁 | P0 | npm run check + npm test |

## 二、本轮明确不做（BLOCKED/超范围）

- 真机项（软键盘、手势条、桌面版网站模式、Android 返回键）：需物理设备，本轮以 Playwright 模拟覆盖，真机项留给用户走查。
- 真实工具审批闭环（宿主真发审批事件）：宿主侧审批档位开启需人工配置，APR-01/02/03 用 SSE 注入 + 决策 POST 断言覆盖（与历史 R1/R3 方法一致）。
- Tailscale/Cloudflare 服务安装类一键操作：涉及系统级变更，只读探测不执行。
- 配对新流程（ACC-03 之外）：edge 配对限速，避免耗尽设备名额（5/5）。

## 三、通过标准

- 全部 P0 通过；P1/P2 失败项列出但不阻塞。
- 无 console pageerror 刷屏；无横向溢出；无浮层残留。
