# Handoff — dsh-mobile-bridge 会话接管

> 更新时间：2026-11-01 13:15 CST
> 接管自 ZCode 会话 `sess_8e01ea64-580c-4d08-a918-799a336fc3a1`（ZCode GLM-5.3-Flash）
> 工作目录：`C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-mobile-bridge`
> 仓库：https://github.com/msz-legend/dsh-mobile-bridge (main @ `d381990`，已推送)

## 1. 项目一句话

DSH Mobile Bridge：让手机浏览器在「不重建前端」的前提下接入本机 DSH Desktop。自建边缘网关（edge）反代宿主 webServer，手机加载同一套 Web UI；审批桥接作为 `approval/request` waterfall 监听器参与宿主决策。

## 2. 当前状态

| 项 | 值 |
|---|---|
| 版本 | **0.4.4** |
| git HEAD | `a5b8f9f` feat: two-step settings nav on narrow screens（= origin/main） |
| 工作树 | 干净 |
| 测试 | `npm test` → 13 + 4 + 4 checks 全绿 |
| edge | 监听 127.0.0.1:8787 + 192.168.0.108:8787（pid 12476） |
| 宿主 webServer | 127.0.0.1:50438 |
| cloudflared | quick tunnel running（pid 7748，startedAt 11:54:11，restarts=1） |
| publicBase | `https://aside-prospects-cst-recall.trycloudflare.com` |
| 公网可达性 | HTTP 200，约 3.0s（含 CF 冷启动） |
| 局域网可达性 | HTTP 200，约 15ms |
| 激活设备 | 0（已清理全部测试设备，待真机配对） |

## 3. 已完成的工作（按提交）

| 提交 | 内容 |
|---|---|
| `f19e9a3` | fix: mobile settings takeover + xhs marketing assets + handoff (v0.4.2) |
| `c144e7f` | chore: bump version to 0.4.2 |
| `374c2d2` | fix: Secure cookie honors real phone→edge protocol (v0.4.3) |
| `d381990` | chore: bump version to 0.4.3 |
| `99edd65` | docs: update handoff to v0.4.3 verified state |
| `a5b8f9f` | feat: two-step settings nav on narrow screens (v0.4.4) |

### 3.1 设置页「UI 卡死」根因与修复

**根因**：宿主设置抽屉 `.AnXs9G_panel`（maxWidth 312px）是「左导航 + 右内容」双栏固定布局；360dp 手机视口下导航占约 60%，内容区只剩 **~124px**，插件 `.dmb-settings` 被压成 **76px 宽**，文字叠成一列，观感就是「卡死」。这影响宿主自己的分区（如「账号与余额」），不只是本插件。

**修复演进**：
1. **自适应**（v0.4.2）：`.dmb-settings` width/max-width 100% + box-sizing + overflow-wrap + overflow auto；`.dmb-grid` 用 `minmax(min(100%,120px),1fr)`；子元素 min-width 0 / overflow-wrap。
2. ~~窄屏全屏 FAB~~（v0.4.2，已在 v0.4.4 移除）：只能救插件自己的分区，宿主其他分区仍错乱。
3. **两级导航**（v0.4.4，现行方案）：`installSettingsNav()` 在 `max-width: 520px` 下把抽屉改为
   - **列表态**：只显示导航，导航占满抽屉；
   - **详情态**：抽屉铺满视口、内容占满宽度、导航隐藏，左上角出现「‹」返回箭头；
   - 定位用 CSS-module 语义后缀（`_options`/`_panel`/`_nav`/`_content`）匹配，宿主换 hash 前缀不受影响，换语义名则规则自动失效、不会误伤。

### 3.2 真机 Secure cookie 修复（v0.4.3）

真机回归暴露：经 adb reverse / 局域网 HTTP 访问时 publicBase 是 https 隧道地址，但手机实际用 http 连 edge；给设备 cookie 打 `Secure` 会被浏览器丢弃，表现为「配对成功但立刻掉回 authentication required」。
修复：edge 转发时打 `x-dmb-proto`，取手机→edge 的真实协议（仅当对端为 loopback 时才采信 `x-forwarded-proto`，防伪造降级）；routes 用 `shouldSecureCookie(req)` 判定。

### 3.3 小红书发帖素材

`marketing/xhs/`：`cover_3x4.png` (1242×1660)、`approval_4x5.png` (1080×1350)、`pairing_1x1.png` (1080×1080)、`xiaohongshu_copy.md`。素材取自真实 probe 截图。

## 4. 运行时验证（2026-11-01 13:30，Playwright，v0.4.4）

| 检查 | 结果 |
|---|---|
| 360dp 列表态 | ✅ 抽屉 312px、只显示导航（nav 312px）、内容隐藏、无返回箭头 |
| 点导航 → 详情态 | ✅ 抽屉 360px、导航隐藏、内容 360px、返回箭头 [8,32,40,40] |
| 插件分区内容 | ✅ 已配对设备 1/5、在线 1、待审批 0、always 规则 0、审批超时 60s/30s、手机端已加载 |
| 宿主「账号与余额」 | ✅ 卡片宽度 76px → **312px**，不再叠字 |
| 返回箭头回列表 | ✅ 生效 |
| 1440 桌面回归 | ✅ 面板 564×338、无 FAB、无 page error |
| `npm test` | ✅ 13 + 4 + 4 全绿 |

> 说明：客户端半身受 edge 的 no-cache 策略，改 `client.js` 后**手机刷新页面即生效**，不需要重启 Desktop。

## 5. 待办

- [ ] **真机回归（等你做）**：手机扫码 → 桌面确认 → 进 UI → 设置（应只看到分区列表）→ 点「手机桥接」（应全宽 + 左上返回箭头）→ 返回 → 点「账号与余额」确认不再叠字 → 审批卡片闭环
- [ ] 若真机仍有问题，先看 `probe/` 下脚本（`verify-two-step.mjs`、`diag-settings.mjs`、`drawer-compare.mjs`）

## 6. 已知限制

1. **quick 隧道地址每次重启 Desktop 都会变**：需重新扫码。要固定域名换 `tunnelMode: 'token'`。
2. **cloudflared 首次连接偶发失败**：本次记录到 restarts=1（`context deadline exceeded`），插件自动重启后恢复；README 已有说明。
3. **两级导航只在 `< 520px` 生效**：桌面抽屉保持宿主原生双栏布局。
4. **依赖宿主 CSS-module 语义后缀**：DSH 若改掉 `_nav`/`_content`/`_options` 命名，补丁会自动失效（界面回到宿主原生布局），不会报错或弄坏页面。

## 7. 快速命令

```sh
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-mobile-bridge
npm run check && npm test
git status --porcelain && git log --oneline -3
# 取当前配对码 / 公网地址
curl -s http://127.0.0.1:50438/plugins/dsh-mobile-bridge/pairing.json
```
