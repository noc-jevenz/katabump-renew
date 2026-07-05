# Katabump Server Auto-Renewal Tool

这是一个用于自动续期 Katabump 服务器的自动化脚本。它利用 Playwright 和 CDP (Chrome DevTools Protocol) 技术来模拟用户操作，能够有效绕过 Cloudflare Turnstile 验证码，确保持续的服务器服务。

通过 **GitHub Actions** 云端定时运行。

## ✨ 特性

- **智能过盾**: 通过 CDP 协议模拟真实鼠标轨迹和点击行为，结合屏幕坐标伪造，高成功率绕过 Cloudflare Turnstile。
- **自动重试**: 内置严格的验证重试机制，如果验证失败会自动重启验证流程。
- **多用户支持**: 支持配置多个账号批量续期。
- **Telegram 通知**: 续期结果（成功/失败/跳过）自动推送到 Telegram，附带截图。
- **运行留存控制**: Actions artifact 和旧 workflow run 记录默认保留 14 天，减少手动清理。
- **故障诊断**: Chrome 启动日志会随截图一起上传，便于排查 GitHub Actions 上的偶发启动问题。

---

## 🚀 GitHub Actions 云端运行

1. **Fork 本仓库** 到你的 GitHub 账号。
2. 进入你的仓库，点击 **Settings** -> **Secrets and variables** -> **Actions**。
3. 点击 **New repository secret**，添加一个名为 `USERS_JSON` 的 Secret。
4. **Value** 的格式必须是 JSON 数组（请尽量压缩为一行）：
   ```json
   [{"username": "your_email@example.com", "password": "your_password"}, {"username": "another@example.com", "password": "pwd"}]
   ```
5. **(可选) 配置代理**:
   如果 GitHub Actions 的 IP 被屏蔽，或者你想使用特定的 IP 访问，可以添加名为 `HTTP_PROXY` 的 Secret。
   - **格式**:
     - 无认证: `http://ip:port`
     - 带认证: `http://username:password@ip:port`
   - **说明**: 脚本会自动检测代理有效性，如果支持认证会自动处理。默认不启用。

6. **(可选) Telegram 消息推送**:
   如果你希望在续期成功、失败或跳过时收到 Telegram 通知（包含截图），请配置以下 Secret：
   - `TG_BOT_TOKEN`: 你的 Telegram Bot Token (从 @BotFather 获取)。
   - `TG_CHAT_ID`: 你的 Chat ID (用户 ID 或群组 ID)。
   > 如果未配置，脚本将跳过发送通知。

7. **(可选) 指定 Chrome 路径**:
   默认会自动查找 `google-chrome` / `chromium`。如果你的运行环境路径不同，可以配置 `CHROME_PATH` 环境变量。

8. 保存后，进入 **Actions** 页面，启用 Workflow。它会在**每天北京时间 08:00 (UTC 00:00)** 自动运行。
9. 你也可以手动点击 "Run workflow" 立即测试。

### 运行结果与截图

- **运行日志**: 在 Actions 中的 `Run Renew Script` 步骤查看。
- **截图留存**: 每次运行（无论成功与否），通过 `Upload Screenshots` 步骤自动上传截图。
  - 你可以在 Workflow 运行详情页的 **Artifacts** 区域下载 `screenshots` 压缩包。
  - 每个账号会保存最终状态截图（`username.png`），续期成功、失败、验证码等关键节点也会保存对应截图。
  - `chrome_startup.log` 会包含 Chrome 启动输出；如果 Chrome 初始化失败，优先查看这个文件和 Actions 日志。
  - 截图 artifact 默认保留 14 天。
- **运行记录清理**: Workflow 会在每次运行结束后删除 14 天前已完成的旧 workflow run 记录。
- **失败状态**: 如果任意账号登录、验证码或续期流程失败，脚本会以非零退出码结束，GitHub Actions 会显示失败；暂未到续期时间会按成功处理。

---

## 🛠️ 项目结构

* `action_renew.js`: 主程序脚本（适配 GitHub Actions 的 Linux/xvfb 环境）。
* `.github/workflows/renew.yml`: GitHub Actions 的定时任务配置文件。
