# Handoff — dsh-mobile-bridge 会话接管

> 生成时间：2026-11-01 10:35 CST
> 接管自 ZCode 会话 `sess_8e01ea64-580c-4d08-a918-799a336fc3a1`（ZCode GLM-5.3-Flash）
> 工作目录：`C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-mobile-bridge`
> 仓库：https://github.com/msz-legend/dsh-mobile-bridge (main @ 7858a5d)

## 1. 项目一句话

DSH Mobile Bridge：让手机浏览器在「不重建前端」的前提下接入本机 DSH Desktop。自建边缘网关（edge）反代宿主 webServer，手机加载同一套 Web UI；审批桥接作为 `approval/request` waterfall 监听器参与宿主决策。

## 2. 当前状态

| 项 | 值 |
|---|---|
| git HEAD | `7858a5d` config: enable cloudflared quick tunnel with absolute tunnelBin |
| 工作树 | 干净（本 handoff 之前未提交改动） |
| 测试 | `npm test` → 13+4+4 checks 全绿 |
| edge | 监听 127.0.0.1:8787 + 192.168.0.108:8787 |
| cloudflared | quick tunnel running `https://silly-crystal-demand-oasis.trycloudflare.com` (pid 11284) |
| publicBase | https://silly-crystal-demand-oasis.trycloudflare.com |
| 配对设备 | 2（dev_ff01639bd73a curl-test 已撤销, dev_606e3d687478 e2e-phone 在线） |
| clientHalf | 6（手机端已加载 6 次） |

## 3. 本次接管完成的工作

### 3.1 诊断并修复「设置页 UI 卡死」bug

**根因**：DSH 宿主设置抽屉（`.AnXs9G_panel`，maxWidth 312px）在手机视口（360dp）下，把插件注入的 `.dmb-settings`（max-width 640px）压成 76px 窄条（depth0 rect=[236,78,76,1136]），导致内容被裁、部分文本不可见、触控命中异常，观感「卡死」。

**证据**：
- `probe/shots/settings-diag/diag.json`：`div.AnXs9G_overlay` 全屏 fixed（z-index 1000, pointer-events auto）拦截触控；`.dmb-settings` 仅 76px 宽。
- 微信截图图2：全屏灰色遮罩 + 中央白色模态卡片，下半部分 y≈1700-2400 空白，无关闭按钮 → 视觉「卡死」。
- 微信截图图1：配对页 `net::ERR_CONNECTION_TIMED_OUT` 白屏（局域网地址 192.168.0.108 在外网不可达）。

**修复**（`client.js` CSS）：
- `.dmb-settings`：width 100% / max-width 100% / box-sizing border-box / overflow-wrap anywhere / overflow auto / max-height 100% / -webkit-overflow-scrolling touch
- `.dmb-grid`：minmax(min(100%,120px),1fr) 避免 140px 最小列宽溢出
- `.dmb-cell`/`.dmb-muted`/`.dmb-addr`/`.dmb-qr`/`.dmb-btn`：min-width 0、overflow-wrap、box-sizing、width 100%

**验证**：`npm run check` 通过；`npm test` 13+4+4 全绿。几何链路仍受限于宿主抽屉宽度（host-side），但插件自身内容不再溢出/被裁。

### 3.2 小红书发帖素材

输出目录：`dsh-mobile-bridge/marketing/xhs/`
- `cover_3x4.png` (1242×1660) — 封面，使用真实 probe 截图
- `approval_4x5.png` (1080×1350) — 审批卡片特写
- `pairing_1x1.png` (1080×1080) — 3 步配对
- `xiaohongshu_copy.md` — 完整文案（架构 / 配对 / 审批 / 外网 / 安全 / 安装）

素材来源：`probe/shots/settings-mobile/0[1-4]-*.png`（真实 Playwright 截图）。

### 3.3 Handoff 文档

本文件。

## 4. 关键文件与修改

| 文件 | 改动 |
|---|---|
| `client.js` | CSS 宽度/换行修复（设置页） |
| `marketing/xhs/*` | 新增 4 个发帖素材 |
| `HANDOFF.md` | 新增 |

未改动：`index.js`、`lib/*`、`test/*`、`cordis.patch.yml`。

## 5. 已知限制 / 后续建议

1. **宿主抽屉宽度是 host-side 限制**：`.AnXs9G_panel` maxWidth 312px 在 360dp 手机视口下内容区仅 124px。插件 CSS 无法突破宿主容器。如需真正全屏体验，建议在 `client.js` 注册 `shell.overlay` 时把设置页也 portal 到 body（类似 ApprovalOverlay 的 createPortal），或向宿主申请全屏 modal slot。
2. **quick 隧道地址每次重启 Desktop 都会变**：需要重新扫码。想要固定域名换 `tunnelMode: 'token'`。
3. **client.js 是 IIFE bundle**：编辑后需宿主热重载（插件已热重载 2 次，日志显示）。
4. **真机截图无法由本模型读取**（combo:recommended-free 不支持 image input）：已用 subagent（GLM-5.3-Flash 侧通道）完成 OCR 分析，结论见 §3.1。

## 6. 快速恢复命令

```sh
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-mobile-bridge
npm run check && npm test
git status --porcelain
git log --oneline -3
```

## 7. 验证清单

- [x] `npm run check` 通过
- [x] `npm test` 13+4+4 全绿
- [x] git 工作树干净（除本次 handoff/素材）
- [x] edge 8787 监听正常
- [x] cloudflared quick tunnel 运行中
- [x] publicBase / 二维码自动切到公网地址
- [x] 小红书 3 图 + 文案生成
- [ ] 真机最终回归（需用户在华为手机上打开新二维码验证设置页可操作）

## 8. 待用户决策

- 是否提交本次 CSS 修复 + 素材 + handoff（建议 commit message: `fix: mobile settings panel overflow + xhs marketing assets`）
- 是否推进「设置页全屏 portal」方案（§5.1）以彻底解决宿主抽屉窄条问题
