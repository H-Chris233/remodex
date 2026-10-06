# Remodex 自用版部署与使用

本 fork 使用 **Windows Codex → 自有 VPS 中转 → iPhone**。已移除 Remodex 订阅限制与 RevenueCat 集成，默认关闭 APNs 注册，保留本地通知。Codex 仍使用 Windows 上已有的登录、订阅或模型供应商配置，Remodex 不提供模型额度。

## VPS：独立 HTTPS 域名

要求：Linux、Docker Engine、Compose v2、指向 VPS 的子域名，以及可用的 TCP 80/443 端口；UDP 443 可选。没有额外代理需求时，DNS 记录使用仅解析模式。

```sh
git clone https://github.com/H-Chris233/remodex.git
cd remodex/deploy
cp .env.example .env
# 修改 .env 中的 REMODEX_DOMAIN，只填写域名，不带 https:// 或路径。
docker compose -f compose.yaml -f compose.https.yaml config --quiet
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
curl --fail https://YOUR_RELAY_DOMAIN/health
```

健康检查应返回 `{"ok":true}`。Windows bridge 使用 `wss://YOUR_RELAY_DOMAIN/relay`。Caddy 自动申请 HTTPS 证书，转发 WebSocket 及可信重连接口；9000 端口不暴露到公网。证书保存在持久卷，更新时不要运行 `down -v`。

## VPS：保留已有反向代理

如果 80/443 已被现有代理占用，使用下面的组合，**不要同时加载 HTTPS 配置**：

```sh
docker compose -f compose.yaml -f compose.existing-proxy.yaml config --quiet
docker compose -f compose.yaml -f compose.existing-proxy.yaml up -d --build --wait
curl --fail http://127.0.0.1:9000/health
```

由现有代理为独立子域名提供 HTTPS，将所有路径转发到 `http://127.0.0.1:9000`。必须支持 WebSocket，并保留 `/health`、`/v1/trusted/session/resolve`。宿主机 Caddy 的配置示例：

```caddyfile
YOUR_RELAY_DOMAIN {
    reverse_proxy 127.0.0.1:9000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
    }
}
```

relay 信任受控代理提供的客户端 IP，因此不要将 9000 绑定到公网，也不要原样透传客户端伪造的 IP 头。如果现有代理也运行在 Docker 内，可将其连接到 `remodex_default` 网络，使用 `relay:9000`，不要使用容器自身的回环地址。

不要记录包含完整 `/relay/{sessionId}` 的代理访问日志；该路径包含配对标识。relay 自身会对连接日志中的标识脱敏。APNs 默认保持关闭。

## Windows bridge

要求：Node.js 24、Git，以及已安装并登录的 Codex CLI。使用当前普通 Windows 用户打开 PowerShell；本流程不会安装或升级 Codex。如果已有本仓库，直接进入其 `phodex-bridge` 目录，无需重复克隆。

```powershell
git clone https://github.com/H-Chris233/remodex.git
cd remodex/phodex-bridge
npm.cmd ci --ignore-scripts
npm.cmd link --ignore-scripts
$env:REMODEX_RELAY = 'wss://YOUR_RELAY_DOMAIN/relay'
remodex up
```

`npm link` 将当前 checkout 注册为 `remodex` 命令，不安装官方 npm 版本。不需要全局命令时，可以省略 link，使用 `node bin/remodex.js 命令`。

`up` 创建当前用户的登录任务，隐藏运行窗口并输出二维码；关闭终端不影响后台运行。任务使用普通权限，不保存 Windows 密码。relay 地址、程序路径及可选 `CODEX_HOME` 保存在用户的 `.remodex` 目录；Codex 凭据继续由 Codex 自己保存。自定义供应商所需的环境变量必须能在用户登录会话中读取，Remodex 不复制临时终端密钥。

保持 checkout 路径稳定。如果移动目录或重装 Node/Codex，重新运行 `remodex start`；必要时用 `REMODEX_CODEX_BIN` 指定新的 Codex `.exe` 或 `.cmd` 绝对路径。默认遵循当前 PATH 中的顺序，支持空格、中文和 `&`，拒绝引号、换行或 `%` 展开。Windows 启动 Codex 时始终带上 `--no-daemon`。

```powershell
remodex status             # 查看任务、心跳、relay、Codex 状态和日志路径
remodex qr                 # 重启并生成新的短期配对二维码
remodex restart
remodex stop
remodex uninstall-service  # 卸载登录任务，保留设备身份和配置
```

`start` 可重复调用；`reset-pairing` 会停止服务并清除设备信任，仅在需要重新配对时使用。`qr --json` 会有意输出完整配对信息，不要分享。普通状态输出和后台日志不包含该信息。`run` 保留前台运行方式，使用前先停止后台任务，并在终端中设置 relay 环境变量。

电脑需要保持开机、登录且不休眠；锁屏可以继续运行。进程异常退出后，任务以一分钟间隔最多重试三次；网络重连由 bridge 处理。停止时会核对工作进程的创建时间和程序路径，仅清理本服务的进程树，不按进程名称批量结束其他 Codex/Node 实例。

## iPhone 与 GitHub Actions

若 GitHub 提示，先在 fork 中启用 Actions。推送 `main` 或手动运行 **Build Unsigned IPA**，下载 `remodex-unsigned-ipa` artifact，其中包含：

- `remodex-unsigned-release.ipa`
- `remodex-unsigned-release.ipa.sha256`

核对 SHA-256 后，用自己的侧载工具签名安装。未签名 IPA 不能直接安装。App 要求 iOS 18.6+，Bundle ID 为 `io.github.hchris233.remodex`，relay 地址通过二维码传入；GitHub 不需要 Apple 签名凭据。免费账号签名的有效期与刷新要求以侧载工具规则为准。

在 Remodex 内扫码后，验证已有会话、选定项目中新建任务、连续发送超过五次、流式回复、审批和停止操作，再切换 Wi-Fi/蜂窝网络或重新打开 App 检查重连。本地通知受 iOS 后台挂起限制，本版本不提供挂起后的 APNs 推送保证。

## 更新与恢复

Windows 先停止 bridge，执行 `git pull --ff-only`，在 `phodex-bridge` 中运行 `npm.cmd ci --ignore-scripts`，再运行 `remodex start`。**不要使用 `npm install -g remodex` 替换个人 fork。**

VPS 更新前记录当前提交，拉取个人 fork 后重新执行原来的 Compose `up -d --build --wait` 命令。失败时切回此前可用提交，重新构建和启动；不要删除 `.remodex` 或 Caddy 持久卷。中转重启会暂时断线，保存的设备信任用于后续重连。

CI 包含 Linux bridge/relay 测试、Windows 启动和真实任务计划程序检查、生产镜像健康检查，以及 macOS Swift 恢复逻辑检查和 IPA 校验。CI 通过不替代公网域名及 iPhone 真机验收。
