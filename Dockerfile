#===================================================
# Dockerfile for Next.js + Nginx + Supervisor
# 阶段 1: 构建前端
#===================================================
FROM node:20-alpine AS builder

ARG WS_URL
ENV NEXT_PUBLIC_WS_URL=${WS_URL}

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com

COPY . .

# 构建前端
RUN npm run build

# ==================================================
# 阶段 2: 最终运行镜像
# ==================================================
FROM node:20-alpine
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories
# 安装 Nginx 和 Supervisor
RUN apk add --no-cache nginx supervisor openrc

# 创建必要的目录
RUN mkdir -p /var/log/supervisor /app/server/videos

WORKDIR /app

# 1. 复制构建产物 (Next.js Standalone 核心文件)
# 注意：standalone 目录包含 server.js 和 .next 子目录
COPY --from=builder /app/.next/standalone ./

# 2. 复制静态资源到正确位置
# standalone 内部已有 .next 目录，需要把 static 复制进去
COPY --from=builder /app/.next/static ./.next/static

# 3. 复制 public 目录
COPY --from=builder /app/public ./public

# 4. 复制后端代码
COPY --from=builder /app/server ./server

# 5. 安装后端缺失的依赖 (ws, dotenv)
# Standalone 自带的 package.json 不包含这些，所以必须单独补装
RUN npm install ws dotenv --registry=https://registry.npmmirror.com

# 6. 复制配置文件
COPY nginx.conf /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisord.conf

EXPOSE 80

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]