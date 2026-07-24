# 通用自部署镜像:Bun 单阶段构建(装依赖 → vite build → 运行 Hono)。
# 使用官方默认 registry,不含任何私有镜像源或主机网络耦合。
FROM oven/bun:1.3.1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1.3.1
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3030
COPY --from=build /app ./
RUN mkdir -p /app/data
EXPOSE 3030
CMD ["bun", "run", "server/index.ts"]
