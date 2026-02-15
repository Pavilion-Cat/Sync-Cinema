
#===================================================
# Dockerfile for Next.js + Nginx + Supervisor
# 阶段 1: 构建前端 (使用 Node.js)
#===================================================
FROM node:18-alpine AS builder

# 设置构建参数 (WebSocket 地址)
# 注意：这里用 ARG 是为了在 build 时传入
ARG WS_URL
ENV NEXT_PUBLIC_WS_URL=${WS_URL}

WORKDIR /app

# 复制依赖文件
COPY package.json package-lock.json* ./
RUN npm ci

# 复制源代码并构建
COPY . .

# 构建前端 (生成 .next 目录)
RUN npm run build

# ==================================================
# 阶段 2: 最终运行镜像 (打包所有东西)
# ==================================================
FROM node:18-alpine

# 安装 Nginx 和 Supervisor
RUN apk add --no-cache nginx supervisor openrc

# 创建必要的目录
RUN mkdir -p /var/log/supervisor /app/server/videos

WORKDIR /app

# 1. 复制 package.json (为了保留运行时依赖)
COPY package.json package-lock.json* ./
# 只安装 production 依赖 (减小体积)
RUN npm ci --production

# 2. 复制前端构建产物
# 注意：因为配置了 standalone，所以直接复制 .next/standalone
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# 3. 复制后端代码
COPY --from=builder /app/server ./server

# 4. 复制 Nginx 配置
COPY nginx.conf /etc/nginx/nginx.conf

# 5. 复制 Supervisor 配置
COPY supervisord.conf /etc/supervisord.conf

# 暴露端口 (容器内部 Nginx 监听 80, 外部映射请到docker-compose.yml中设置)
EXPOSE 80

# 启动 Supervisor (它会自动拉起 Nginx, Frontend, Backend)
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
