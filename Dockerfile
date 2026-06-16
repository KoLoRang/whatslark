# WhatsLark 镜像：编译 TS → 运行 Node 服务（无 Web 配置页，用 CLI + 配置文件）
FROM node:22-slim

# better-sqlite3 需要编译工具；ffmpeg 用于媒体转码；sqlite3 CLI 供 whatslark 脚本查询
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ffmpeg ca-certificates sqlite3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 安装 CLI 命令脚本
COPY bin/whatslark.sh /usr/local/bin/whatslark
RUN chmod +x /usr/local/bin/whatslark

VOLUME ["/data"]
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV DB_PATH=/data/bridge.db
ENV TZ=Asia/Shanghai

CMD ["node", "dist/index.js"]
