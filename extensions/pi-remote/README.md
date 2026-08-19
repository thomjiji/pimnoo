# Pi Remote Prototype

这是一个可丢弃的只读 Web Alpha Prototype，用来验证手机通过私人 tailnet 阅读当前 Pi TUI Session 的体验。它不会启动第二个 Pi 进程，也不会取得会话所有权。

扩展默认只注册命令，不自动监听端口。开发时把本目录 plug 到 Pi settings，执行 `/reload`，再运行：

```text
/pi-remote-start --host 0.0.0.0 --port 8787 --public-url https://你的设备名.你的-tailnet.ts.net/
```

Pi 会显示包含临时 token 的完整手机访问地址。使用 `/pi-remote-url` 再次显示地址，使用 `/pi-remote-stop` 停止服务。自动生成的 token 在同一个 Pi 进程内切换或 `/resume` Session 时保持不变，重启 Pi 进程后重新生成；设置 `PI_REMOTE_TOKEN` 可以跨进程固定它。

要让扩展随正常 Pi 会话自动启动，在启动 Pi 进程前设置：

```bash
PI_REMOTE_ENABLED=1
PI_REMOTE_HOST=0.0.0.0
PI_REMOTE_PORT=8787
PI_REMOTE_TOKEN="$(openssl rand -hex 16)"
PI_REMOTE_PUBLIC_URL='https://你的设备名.你的-tailnet.ts.net/'
```

## Tailscale Serve

推荐在运行 Docker Desktop 的 Windows 或 WSL 节点上做一次长期配置，而不在 Pi 容器里安装 Tailscale：

```powershell
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

`--bg` 配置会在后台持续存在并在设备或 Tailscale 重启后恢复。Docker 端口只发布到主机 loopback：

```powershell
--publish 127.0.0.1:8787:8787
```

最终链路是手机 HTTPS 请求经过私人 tailnet 和 Tailscale Serve，在主机终止 TLS 后转发到 Windows loopback、Docker 端口和 extension HTTP Server。不要使用 Tailscale Funnel，因为这个原型不应暴露到公网。

扩展只负责监听地址和端口，不会自行创建 tailnet 地址；`PI_REMOTE_PUBLIC_URL` 也只是展示给用户的地址提示，不会配置网络。Alpha 同一时间只支持一个启用的 Pi 进程；同一容器或网络命名空间中的第二个实例会因为端口已占用而启动失败。
