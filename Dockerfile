# 自部署镜像:node 阶段按 package-lock.json 装依赖并构建前端,bun 阶段只负责运行。
# 使用官方默认 registry,不含任何私有镜像源或主机网络耦合。
#
# Reason: 依赖必须用 npm 装(与本地开发、与仓库里的 package-lock.json 完全一致)。
# 早先用 `bun install` 装依赖踩了两个坑:①esbuild(drizzle-kit 的传递依赖)的 postinstall
# 二进制校验在 bun 下失败;②bun 生成的 node_modules 里 .bin/vite 是符号链接,vite CLI 的
# '../dist/node/cli.js' 会相对它解析到不存在的路径。改用 npm 后两者都不存在,
# 且 Docker 与本地装出来的是同一棵依赖树。
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build --config client/vite.config.ts

FROM oven/bun:1.3.1
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3030
COPY --from=build /app ./
RUN mkdir -p /app/data
EXPOSE 3030
CMD ["bun", "run", "server/index.ts"]
