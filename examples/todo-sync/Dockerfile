# Build from the repository root — the example consumes workspace
# packages: docker build -f examples/todo-sync/Dockerfile -t todo-sync .
FROM node:24-slim
RUN npm install -g pnpm@11
WORKDIR /app
# playwright is a workspace devDependency; the demo image needs no browsers
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY . .
RUN pnpm install --frozen-lockfile --filter "example-todo-sync..." --filter "example-todo-sync-web..."
RUN pnpm --filter "@remelondb/core" --filter "@remelondb/driver-web" --filter "@remelondb/server" run build
RUN pnpm --filter example-todo-sync-web run build
EXPOSE 8787
CMD ["pnpm", "--filter", "example-todo-sync", "serve"]
