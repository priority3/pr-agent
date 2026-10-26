# 自部署镜像:node 阶段按 package-lock.json 装依赖并构建前端,bun 阶段只负责运行。
#
# Reason: 依赖必须用 npm 装(与本地开发、与仓库里的 package-lock.json 完全一致)。
# 早先用 `bun install` 装依赖踩了两个坑:①esbuild(drizzle-kit 的传递依赖)的 postinstall
# 二进制校验在 bun 下失败;②bun 生成的 node_modules 里 .bin/vite 是符号链接,vite CLI 的
# '../dist/node/cli.js' 会相对它解析到不存在的路径。改用 npm 后两者都不存在,
# 且 Docker 与本地装出来的是同一棵依赖树。
#
# 运行时只留运行所需(2026-10-21 实测 424 MB → 313 MB,起容器自检通过):
#   · 构建阶段末尾 `npm prune --omit=dev`:剪掉 86 MB 纯构建期依赖(typescript 23 / drizzle-kit 17 /
#     @babel 12 / lightningcss 11 / @esbuild 10 / @types 4 / vite 3 / …);
#   · 运行阶段不再 `COPY --from=build /app ./`(那会把整棵 node_modules、源码、锁文件一并搬过去),
#     只拷运行时真正要的文件。
#
# 两个关键依赖,漏了容器直接起不来:
#   · tsconfig.json —— server 里写 `@/routes/...`,`@/*` → `./server/*` 由 bun 运行时按 tsconfig 解析;
#   · client/dist   —— hono 的 serveStatic 读 `./client/dist`,是前端产物的唯一来源。
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# 国内链路下 npmjs 对几百个包的并发下载会间歇性掐断(这正是 2026-09 把构建挪去 runner 的原因)。
# 默认走 npmmirror;换环境可 `--build-arg NPM_REGISTRY=https://registry.npmjs.org` 覆盖。
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --no-audit --no-fund --registry="${NPM_REGISTRY}"
COPY . .
RUN npx vite build --config client/vite.config.ts
# 前端已构建完,构建期依赖不再需要 —— 剪掉,别带进运行镜像。
RUN npm prune --omit=dev --no-audit --no-fund

FROM oven/bun:1.3.1
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3030
COPY --from=build /app/package.json  ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/server        ./server
COPY --from=build /app/client/dist   ./client/dist
COPY --from=build /app/node_modules  ./node_modules
RUN mkdir -p /app/data
EXPOSE 3030
CMD ["bun", "run", "server/index.ts"]
