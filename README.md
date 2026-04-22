# Sync-Cinema

一个用于局域网 / 私有部署场景的同步观影系统：主持人控制播放，观众端自动跟随，实现多端一致的播放进度、暂停状态与切片切换。

<div align="center">

![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)
![Node](https://img.shields.io/badge/Node.js-20+-green?style=flat-square&logo=node.js)
![License](https://img.shields.io/badge/License-GPLv3-blue?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-Ready-blue?style=flat-square&logo=docker)

</div>

## 特性

- 主持人 / 观众双角色模型
- 基于 WebSocket 的实时同步
- 支持播放、暂停、拖动、强制同步
- 观众端偏移检测与一键追平
- 支持全屏场景下的同步提示
- 支持 Docker 部署
- 支持基于 Cookie 的登录态鉴权

## 技术栈

- Next.js 16
- React 19
- Node.js
- ws
- Nginx
- Docker

## 项目结构

```text
src/app/           Next.js 页面
server/            同步服务与视频接口
public/            静态资源
Dockerfile         容器构建脚本
docker-compose.yml Docker Compose 示例配置
nginx.conf         反向代理配置
```

## 使用场景

适用于以下场景：

- 家庭影院 / 局域网同步观影
- 私有服务器上的多人同步看片
- 由一名主持人统一控制节奏的放映场景

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/Pavilion-Cat/Sync-Cinema.git
cd Sync-Cinema
```

### 2. 准备视频文件

将可播放的视频文件放到：

```text
server/videos
```

### 3. 配置环境

编辑 `docker-compose.yml`，至少配置以下环境变量：

- `SYNC_PASSWORD`
- `ADMIN_PASSWORD`
- `AUTH_TOKEN_SECRET`

其中：

- `SYNC_PASSWORD`：观众进入房间的密码
- `ADMIN_PASSWORD`：主持人控制页面的密码
- `AUTH_TOKEN_SECRET`：服务端签名登录态所使用的密钥

> 生产环境请使用高强度随机值，不要使用弱口令。

### 4. 启动

```bash
docker compose up -d --build
```

### 5. 访问系统

打开部署地址后：

- 输入房间密码可作为观众进入
- 输入房间密码 + 主持人密码可进入主持人页面

## 登录与鉴权

当前版本使用服务端签名 Token + Cookie 作为登录态：

- 登录接口：`POST /api/auth/login`
- 登录状态：`GET /api/auth/me`
- 退出登录：`POST /api/auth/logout`
- WebSocket：`/sync`

说明：

- 前端不再持久化保存房间密码或主持人密码
- 登录成功后由服务端签发 Cookie
- WebSocket 握手阶段通过 Cookie 完成鉴权
- `/api/videos` 也需要登录后访问

## 本地开发

安装依赖：

```bash
pnpm install
```

启动前端开发环境：

```bash
pnpm dev
```

启动同步服务：

```bash
node server/index.js
```

生产构建：

```bash
pnpm build
```

## Docker 部署说明

仓库中提供的 `docker-compose.yml` 是一个通用示例，适合直接端口映射的部署方式。

如果你的生产环境使用：

- 反向代理
- 容器网络转发
- 域名网关
- HTTPS / WSS

请根据实际外部访问地址调整构建参数中的 `WS_URL`。

注意：

- `WS_URL` 是前端在构建时写入的 WebSocket 地址
- 它应当指向“浏览器最终访问到的公开地址”
- 如果外部访问地址发生变化，需要重新构建镜像

## 配置项

| 名称 | 说明 |
| --- | --- |
| `WS_URL` | 前端使用的 WebSocket 地址，构建时注入 |
| `SYNC_PASSWORD` | 观众访问密码 |
| `ADMIN_PASSWORD` | 主持人访问密码 |
| `AUTH_TOKEN_SECRET` | 用于签名登录 Token 的密钥 |

## 行为说明

- 主持人端拥有播放控制权
- 观众端会自动跟随主持人状态
- 观众端可在检测到明显进度偏差时主动执行同步
- 全屏状态下会使用原生确认框进行同步提示，以避免普通弹窗被全屏层遮挡

## 适配与部署建议

- 建议通过反向代理统一暴露 HTTP 与 WebSocket
- 如果使用 Nginx，请确保 `/sync` 已正确配置 Upgrade 头
- 如果需要记录真实客户端 IP，请透传 `X-Real-IP` 与 `X-Forwarded-For`
- 生产环境建议使用 HTTPS / WSS

## 安全说明

- 请务必为 `SYNC_PASSWORD`、`ADMIN_PASSWORD`、`AUTH_TOKEN_SECRET` 设置安全值
- 不建议在公开环境中使用弱密码
- 若配置发生泄露，请及时更换相关凭据

## 许可证

本项目采用 [GPL-3.0](LICENSE) 开源许可。

如果你分发了修改后的版本，请遵守 GPL 协议要求。

## 贡献

欢迎提交 Issue 和 Pull Request。
