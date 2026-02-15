# Sync-Cinema
> 一款基于 WebSocket 的私人实时同步观影工具，支持主持人精准控制，观众零延迟同步。

<div align="center">

![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)
![Node](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)
![License](https://img.shields.io/badge/License-GPLv3-blue?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-Ready-blue?style=flat-square&logo=docker)

</div>

## 核心功能

- **实时同步**：基于 WebSocket，毫秒级同步播放、暂停、进度跳转。
- **角色分离**：
  - **主持人**：拥有控制权，可切换视频、控制进度、强制同步。
  - **观众**：被动跟随，享受沉浸式观影体验。
- **私密安全**：通过房间密码和管理员密码保护访问。
- **容器化部署**：集成 Nginx、Next.js、Node.js 后端于一个 Docker 镜像中，部署极简。
- **现代化 UI**：基于 Shadcn/UI 构建的精美界面

## 快速开始 (推荐使用 Docker)

这是最简单的部署方式，无需手动配置 Node.js 环境。

### 1. 准备环境

确保你的服务器已安装 **Docker** 和 **Docker Compose**。

### 2. 克隆项目

```bash
git clone https://github.com/Pavilion-Cat/Sync-Cinema.git
cd Sync-Cinema
```

### 3. 配置参数

修改根目录下的 `docker-compose.yml` 文件，填写你的服务器信息：

```yaml
services:
  yunge_cinema:
    build:
      context: .
      dockerfile: Dockerfile
      # 构建时传入服务器的公网 IP 或域名
      args:
        WS_URL: "ws://example:80" 
    container_name: Sync-Cinema-yunge
    restart: always
    ports:
      - "80:80" # 宿主机80 -> 容器内80
    environment:
      # 后端环境变量,生产环境请修改为安全的值
      - SYNC_PASSWORD=default
      - ADMIN_PASSWORD=admin_control
    volumes:
      # 挂载视频目录
      - ./server/videos:/app/server/videos
```

### 4. 放置视频文件

将你的 MP4 视频文件放入项目目录的 `server/videos` 文件夹中。

### 5. 启动服务

```bash
docker compose up -d --build
```

### 6. 访问

打开浏览器访问：`http://你的服务器IP:你设置的端口`

## 配置说明

| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `WS_URL` | WebSocket 连接地址（构建时写入，必须为公网地址） | `ws://localhost:80` |
| `SYNC_PASSWORD` | 观众进入房间所需的密码 | `default` |
| `ADMIN_PASSWORD` | 主持人控制所需的密码 | `admin_control` |
| `ports` | 宿主机映射端口 | `80` |

> **重要提示**：如果你更换了服务器的 IP 地址，需要修改 `docker-compose.yml` 中的 `WS_URL` 并重新执行 `docker-compose up -d --build`。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 开源协议

本项目基于 [GNU General Public License v3.0](LICENSE) 开源。

> **注意**：这意味着如果你修改并分发了本项目的代码，你必须同样以 GPLv3 协议开源你的修改内容。

---

**Made with by [Pavilion_Cat]**
**Star ⭐ this repo if it helps you!**