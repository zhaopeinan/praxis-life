# 目标机是阿里云 x86_64 服务器，平台在 FROM 上显式声明（而不是靠命令行的 --platform）：
# 命令行的 --platform 会让 CLI 内置的 legacy builder 在模拟执行时丢掉中间镜像的平台信息而构建失败，
# 写在 FROM 上则 buildx 与 legacy builder 都能正确产出 linux/amd64 镜像。
FROM --platform=linux/amd64 node:22-bookworm-slim AS build
WORKDIR /app
# corepack 下 pnpm 二进制走 npmmirror：构建容器直连 npmjs 会 fetch failed。
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry https://registry.npmmirror.com \
  && corepack enable
# workspace 清单 + 全部子包清单，一次性装好依赖（含 postgres 补丁）。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY . .
# 两个前端：知行人生 dist-web + 白泽 Web（带 /assistant 前缀）。
RUN pnpm build:web

FROM --platform=linux/amd64 node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    DUOWEI_HOST=0.0.0.0 \
    DUOWEI_PORT=8787 \
    DUOWEI_WEB_ROOT=/app/dist-web \
    DUOWEI_DEV_CODES=0 \
    DUOWEI_COOKIE_SECURE=0
RUN npm config set registry https://registry.npmmirror.com \
  && corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod \
  && mkdir -p /app/data \
  && test -x node_modules/.bin/tsx
COPY src ./src
COPY tsconfig.json ./
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/packages/web/dist ./packages/web/dist
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "src/listen.ts"]
