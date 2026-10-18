# 部署与恢复

这是已部署原型的可迁移版本。通用脚本在发布整理时进行了离线校验和无签名构建；它们没有重新部署现有云资源或重启当前 iPad。实际使用需要自己的 Cloudflare 账号、模型授权、Apple 签名与设备配对。

## 环境与私有配置

- 常驻主机：Linux、Node.js 22、Python 3、systemd 用户服务；能通过 HTTPS 访问 Cloudflare 和模型。
- 初始部署 Mac：完整 Xcode，已接受许可并完成组件安装；iPad 已信任电脑、开启开发者模式。
- iPad：有效开发签名、充电、联网、保持可操作状态。
- Cloudflare：免费 Workers 与 D1；部署令牌仅需目标账户 Workers Scripts 与 D1 编辑权限。

运行钥匙由部署脚本生成，保存到 git 忽略的 `.local/queue-private.json`。结构见 `config/queue-private.example.json`，示例中的字符串不可用于实际部署。

## 部署云端

以下示例使用 Bash，令牌通过交互读取，避免出现在命令参数和历史记录中。账户 ID 为个人 Cloudflare 控制台中的目标账户。

```bash
export CLOUDFLARE_ACCOUNT_ID='YOUR_ACCOUNT_ID'
read -rs -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
python3 scripts/deploy-cloud.py --script-name ipad-https-agent --device-id home-ipad
unset CLOUDFLARE_API_TOKEN
```

账户尚无 workers.dev 子域时，首次增加 `--subdomain YOUR_CHOSEN_SUBDOMAIN`。脚本创建或复用同名 D1、初始化表结构、上传 Worker 与静态控制台、写入四类独立密钥，并启用 workers.dev 地址。它会修改指定 Worker；部署前可保留已验证版本与私有配置。重复执行沿用 `.local/` 的设备钥匙与部署身份，目标不一致时拒绝执行。

返回 URL 后，无凭据的 `/health` 可检查协议存活；设备与任务接口需 Bearer 认证。部署短期令牌可以在部署完成后撤销，运行钥匙的撤销需要单独处理。

## 配置后台 Agent

后台主机只需要 URL 与 `agent_token`。Controller 和 device 钥匙无需复制到这台主机。可以从部署端的私有配置提取一个独立文件，再通过已授权的管理通道传输：

```bash
python3 - <<'PY'
import json,os
from pathlib import Path
c=json.loads(Path('.local/queue-private.json').read_text())
p=Path('.local/agent-input-private.json')
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
os.fchmod(fd,0o600)
with os.fdopen(fd,'w') as f:
    json.dump({'url':c['url'],'agent_token':c['agent_token']},f)
PY
```

在已获取源码和该私有文件的 Linux 主机上：

```bash
npm install --prefix devbox/runtime --save-exact @openai/codex@0.163.0
python3 scripts/configure-agent.py --queue-config /PRIVATE/PATH/agent-input-private.json
CODEX_HOME="$PWD/devbox/codex-home" "$PWD/devbox/runtime/node_modules/.bin/codex" login --device-auth
mkdir -p "$HOME/.config/systemd/user"
install -m 600 .local/ipad-https-agent.service "$HOME/.config/systemd/user/ipad-https-agent.service"
systemctl --user daemon-reload
systemctl --user enable --now ipad-https-agent.service
systemctl --user status ipad-https-agent.service
```

Codex 登录由账号本人在官方页面完成。服务正常运行且允许退出登录后继续运行时，可由具备权限的操作者启用该用户 linger。服务使用独立 `devbox/codex-home`；运行时凭据、日志和状态文件均被 Git 忽略。

配置生成器将当前主机的绝对路径写入私有运行配置，仓库本身没有固定员工路径。若迁移源码目录或 Node 路径，需要重新生成配置并重启服务。日志位于 `devbox/logs/`，需要按个人内容保护。

## 构建 iPad Runner

```bash
git submodule update --init
python3 scripts/build-runner.py --bundle-id com.YOUR_PREFIX.ipadagent --team YOUR_TEAM_ID --device YOUR_DEVICE_ID
```

脚本验证 WDA submodule 的 commit，复制到 `build/WebDriverAgent/` 后应用补丁与原生领取器，保留 submodule 干净。签名构建允许 Xcode 创建或更新开发证书、App ID 与描述文件。Apple 登录、法律确认、设备密码和信任操作由本人完成。

只编译验证而不使用签名：

```bash
python3 scripts/build-runner.py --no-sign
```

无签名产物无法安装到真机。已有 `build/WebDriverAgent/` 时脚本拒绝覆盖，可以将旧构建目录移动到其他位置后重新准备。

## 预安装副本与启动

先准备独立副本，签名 identity 来自本机 `security find-identity -v -p codesigning`。脚本保留 Xcode 原始产物，移除副本中设备系统提供的 XCTest 依赖，开启本地网络 ATS 例外，再重新签名验证。

```bash
python3 scripts/prepare-runner.py \
  --source build/DerivedData/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app \
  --output build/Standalone/WebDriverAgentRunner-Runner.app \
  --identity YOUR_CODESIGN_IDENTITY
xcrun devicectl device install app --device YOUR_DEVICE_ID build/Standalone/WebDriverAgentRunner-Runner.app
python3 scripts/launch-device.py \
  --device YOUR_DEVICE_ID \
  --bundle-id com.YOUR_PREFIX.ipadagent.xctrunner \
  --queue-config .local/queue-private.json
```

首次安装后可能需要在 iPad 的“VPN 与设备管理”中信任开发者证书。设备需具备有效开发者测试环境；DDI 未挂载、设备锁定或签名未信任时无法启动。手动点击 Runner 图标可能闪退，不能作为恢复方法。

更新后也可能出现 `Profile Needs Network Validation`。本地 `codesign --verify` 成功仍需设备端完成 Apple 的联网验证；可在“设置 → 通用 → VPN 与设备管理 → 开发者 App”查看并完成“验证 App”。2026-10-18 的更新已观察到此状态，完成设备验证后通过原启动脚本恢复，无需新建凭据或扩大权限。

预安装处理依据 [Appium 官方说明](https://appium.github.io/appium-xcuitest-driver/latest/guides/run-preinstalled-wda/)。免费 [Apple Personal Team](https://developer.apple.com/help/account/basics/about-your-developer-account) 描述文件通常自签发 7 天到期，需重新构建安装。提高签名有效期无法单独解决进程退出或重启恢复。

## 提交目标与检查截图

控制 CLI 默认使用 `.local/queue-private.json`，也可通过 `IPAD_QUEUE_CONFIG` 指向其他私有文件。

```bash
node scripts/control.mjs status
node scripts/control.mjs op screenshot
node scripts/control.mjs goal '返回主屏幕并截图'
node scripts/control.mjs wait goals TASK_UUID
node scripts/control.mjs wait operations OPERATION_UUID
```

截图写入本地 `outputs/ipad-screenshots/`。网页入口为 Worker URL；Controller 钥匙只保存在页面内存。网页目标完成后取的是当时当前画面，尚未绑定不可变历史证据。

先验证 USB 连接时的状态和截图，再断开 USB、关闭组网客户端，将 Mac 与 iPad 置于不同网络后提交一条新目标。原型已通过此实验；Mac 真正关机的实验仍待完成。

## 停止与恢复

`systemctl --user stop ipad-https-agent.service` 会停止新目标领取；已经进入设备端的触控仍可能执行，无法将进程终止当作事务取消。遇到超时或结果未知时，优先查询原 UUID 与当前截图。

Runner 退出、重启或签名到期后，当前需要已配对 Mac 恢复。保留此前验证通过的配置与 Runner，可在旧版本恢复后重新检查设备领取、截图、原任务状态，再执行无副作用目标。避免将恢复过程变成旧触控的自动重放。

## 更新清理索引与长轮询

沿用原 `.local/` 身份重新运行 `scripts/deploy-cloud.py`，会通过 `CREATE INDEX IF NOT EXISTS jobs_expires ON jobs(expires_at,id)` 为现有数据库添加索引，保留历史记录与运行钥匙。该索引创建会产生一次性读写用量。Worker 对旧领取器保持兼容；设备更新到 `ipad-https-3` 后启用自适应长轮询。

设备更新需要重新构建、准备签名副本并安装启动。可保留旧构建目录与已验证 Runner 用于恢复；已有 `build/WebDriverAgent/` 时先将其移动到备份位置。新版本仅重试结果上传，遇到领取后中断的触控仍需核查原任务。Bot 的 `SKILL.md` 同步后会依据状态接口的 `stale_after_ms` 判断心跳。
