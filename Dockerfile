# 目标机是阿里云 x86_64 服务器，平台在 FROM 上显式声明（而不是靠命令行的 --platform）：
# 命令行的 --platform 会让 CLI 内置的 legacy builder 在模拟执行时丢掉中间镜像的平台信息而构建失败，
# 写在 FROM 上则 buildx 与 legacy builder 都能正确产出 linux/amd64 镜像。
FROM --platform=linux/amd64 node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
  && npm ci
COPY . .
RUN npm run build:web

FROM --platform=linux/amd64 node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DUOWEI_HOST=0.0.0.0 \
    DUOWEI_PORT=8787 \
    DUOWEI_WEB_ROOT=/app/dist-web \
    DUOWEI_DEV_CODES=0 \
    DUOWEI_COOKIE_SECURE=0
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
  && npm ci --omit=dev
COPY --from=build /app/dist-web ./dist-web
COPY src ./src
COPY tsconfig.json ./
RUN mkdir -p /app/data \
  && test -x node_modules/.bin/tsx
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "src/listen.ts"]
