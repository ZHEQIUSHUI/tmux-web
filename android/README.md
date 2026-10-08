# tmux-web 安卓 App

和 Mac App 一样是个「壳」：在 App 里维持一条到服务器的 SSH 端口转发，在窗口里打开 tmux-web 网页。网页内容由服务器提供，服务器更新后点顶部的 ⟳ 就是新版。

## 安装和使用

1. 下载 [tmux-web-android.apk](https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/tmux-web-android.apk)，点开安装（系统可能要求允许「安装未知应用」）。Android 8 起。
2. 第一次打开填写服务器，先选连接方式：
   - **直接访问**：已经能直接访问服务器时用（比如在 EasyTier、局域网里），只填网址，比如 `http://10.126.126.2:8080`
   - **SSH 转发**：通过 SSH 端口转发访问，填下面这些：
   - **SSH 目标**：`user@host`
   - **SSH 端口**、**服务器上 tmux-web 的端口**（默认 8080）、**本地端口**（默认 18080，固定不变，网页的登录状态才能保留）
   - **SSH 密码**：可选，留空则需要时弹框输入
   - **SSH 私钥**：可选，粘贴私钥内容，或者「从文件导入」
3. 点「保存并连接」。需要验证码时会弹框输入。

## 功能

- 内置 SSH（sshj），支持私钥、密码、验证码（两步验证），断线自动重连
- 在后台保持连接（通知栏里有一条「已连接」），网页的「等待确认 / 任务完成」提醒变成系统通知，点通知跳到对应会话
- 配置（包括密码和私钥）用安卓系统密钥库加密保存
- 服务器的主机密钥第一次连接时记住，之后变了会拒绝连接（防冒充）；服务器重装过的话在设置里点「忘记主机密钥」
- 平板自动用电脑版布局，手机用手机版；网页「我的」菜单里可以手动切换（自动 / 手机版 / 电脑版）
- 自动检查更新（通过你的 tmux-web 服务器，取不到时直接访问 GitHub），提示后下载安装
- 返回键在网页里后退；退到底时 App 转到后台，连接和提醒照常

## 编译

```sh
cd android
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` 里写 `sdk.dir=<安卓 SDK 路径>`（需要 platform 35 和 build-tools 35.0.0）。

## 发版（CI）

`.github/workflows/apps.yml` 同时编译 Mac 和安卓版，发布到 GitHub Release（标记为最新），并生成 `version.json` 给 App 检查更新用。**平时推代码不会触发**，只有下面两种情况才会：

- 推送标签：`git tag -a app-v1.2.0 -m "更新说明" && git push origin app-v1.2.0`
- 在 GitHub 的 Actions → Apps → Run workflow 手动运行，填版本号和更新说明

### 安卓签名密钥（只需设置一次）

安卓 App 每次更新必须用同一个密钥签名，否则无法覆盖安装。密钥不能放进仓库，要存到 GitHub 的 Secrets 里：仓库 Settings → Secrets and variables → Actions → New repository secret，添加两个：

| 名字 | 内容 |
|---|---|
| `ANDROID_KEYSTORE_B64` | 密钥文件的 base64（`base64 -w0 release.jks`） |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥的密码 |

密钥文件和密码务必另外备份好：丢了以后，新版本就没法覆盖安装旧版本了（只能卸载重装）。
