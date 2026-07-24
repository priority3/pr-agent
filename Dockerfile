# 通用自部署镜像:Bun 单阶段构建(装依赖 → vite build → 运行 Hono)。
# 使用官方默认 registry,不含任何私有镜像源或主机网络耦合。
FROM oven/bun:1.3.1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .
# Reason: 直接执行 vite 真实入口,绕开 bun 装的 node_modules 里 .bin/vite 符号链接
# 导致的 "Cannot find module '../dist/node/cli.js'"(相对 .bin 解析到不存在的 node_modules/dist)。
RUN bun ./node_modules/vite/bin/vite.js build --config client/vite.config.ts

FROM oven/bun:1.3.1
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3030
COPY --from=build /app ./
RUN mkdir -p /app/data
EXPOSE 3030
CMD ["bun", "run", "server/index.ts"]
