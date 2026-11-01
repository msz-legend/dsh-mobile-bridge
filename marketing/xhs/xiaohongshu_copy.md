# DSH Mobile Bridge：把 DeepSeek Harness 搬到手机上

用手机浏览器就能接入本机的 DSH Desktop —— 会话列表、流式输出、停止输出全部零改动复用，只有「工具审批」需要桥接。

## 它做了什么

1. **边缘网关 edge**：在 127.0.0.1:8787 监听，把手机流量反代到宿主，并做设备令牌闸门。
2. **审批桥接**：作为 approval/request waterfall 的监听器参与宿主决策，把请求推给手机卡片，把手机决策回传；超时与离线按 fail closed 处理。

## 3 步配对

1. 桌面打开配对页 → 显示 6 位一次性配对码 + 二维码（5 分钟有效）
2. 手机扫码或输入配对码 → 桌面弹出「配对请求」卡片 → 点允许
3. 手机自动拿到设备令牌 + 宿主 owner cookie → 直接进入 Web UI

## 审批卡片

- 仅本次 / 始终允许 / 拒绝
- 高风险工具标红，参数预览可滚动
- 远程会话无设备 → fail closed；本地会话 → 交还桌面
- always 规则按 session / global 两种 scope 记忆

## 外网接入

- cloudflared quick tunnel：零账号、免费、自动 TLS，4G 也能用
- Tailscale serve：隐私优先
- 局域网直连：在家用

## 安全

- 设备令牌 HttpOnly Cookie，1 年
- 配对码 5 分钟 TTL、一次性、同码最多 3 次尝试
- 配对接口按 IP 每分钟 20 次限速，超限熔断 10 分钟
- 默认最多 5 台设备，可撤销

## 安装

DSH Desktop 里把本目录作为 bundle 安装，或写进 profile dependencies 后重启。
依赖只有一个：qrcode。

GitHub: github.com/msz-legend/dsh-mobile-bridge
