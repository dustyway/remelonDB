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

# The runtime keeps only the backend graph — prod deps, package sources
# run via tsx — plus the built web client. No frontend toolchain, no
# devDependencies, no playwright.
FROM node:24-slim
RUN npm install -g pnpm@11
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "example-todo-sync..."
COPY --from=build /app/examples/todo-sync/frontend/dist ./examples/todo-sync/frontend/dist
EXPOSE 8787
CMD ["pnpm", "--filter", "example-todo-sync", "serve"]
