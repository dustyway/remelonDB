# Build from the repository root — the example consumes workspace
# packages: docker build -f examples/todo-sync/Dockerfile -t todo-sync .
FROM node:24-slim AS build
RUN npm install -g pnpm@11
WORKDIR /app
# playwright is a frontend devDependency; the build needs no browsers
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY . .
RUN pnpm install --frozen-lockfile --filter "example-todo-sync..." --filter "example-todo-sync-web..."
RUN pnpm --filter "@remelondb/core" --filter "@remelondb/driver-web" --filter "@remelondb/server" --filter "@remelondb/store-drizzle" run build
RUN pnpm --filter example-todo-sync-web run build

RUN pnpm --config.node-linker=hoisted --filter example-todo-sync deploy --legacy --prod /deployed

# The runtime is a pnpm-deployed bundle: only the backend package and
# its prod graph (workspace deps copied in, hoisted so peers resolve),
# plus the built web client. No pnpm, no toolchain, no devDependencies.
FROM node:24-slim
WORKDIR /app
COPY --from=build /deployed .
COPY --from=build /app/examples/todo-sync/frontend/dist ./frontend-dist
ENV DIST=/app/frontend-dist
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "serve.ts"]
