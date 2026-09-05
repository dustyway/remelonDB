/**
 * The wire protocol's canonical HTTP binding (sync-wire.md §6) as a
 * NestJS module: every protocol outcome — including conflict and
 * resyncRequired — is HTTP 200 with the variant in the body; only
 * transport failures use statuses (400 malformed, 401 unauthenticated).
 * The engine and validation derive from the same per-table Zod objects
 * the client builds its schema from (zod-adapter.md), so a table is
 * declared once and checked at every trust boundary.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { DynamicModule, FactoryProvider } from '@nestjs/common';
import { z } from 'zod';
import type { DirtyRaw, SyncPullResult, SyncPushResult } from '@remelondb/core';
import { syncSchemas } from '@remelondb/core/zod';
import { createSyncEngine, SyncProtocolError } from '@remelondb/server';
import type {
  SyncEngineOptions,
  SyncStore,
  TableConfig,
} from '@remelondb/server';

export interface RemelonSyncOptions<Scope> {
  readonly store: SyncStore<Scope>;
  /** Per-table Zod objects — the same ones the client's zodTable uses. */
  readonly tables: { readonly [table: string]: z.ZodObject<z.ZodRawShape> };
  /**
   * Per-table engine config beyond validation (e.g. `appendOnly`).
   * Validation always comes from {@link tables}; it cannot be
   * overridden here.
   */
  readonly tableOptions?: {
    readonly [table: string]: Omit<TableConfig, 'validate'>;
  };
  /**
   * The authenticated principal for a request (e.g. the session's user
   * id); null, undefined or an empty scope answers 401. Auth itself
   * stays the app's.
   */
  readonly scopeFrom: (
    request: unknown,
  ) => Scope | null | undefined | Promise<Scope | null | undefined>;
  readonly crossValidate?: SyncEngineOptions<Scope>['crossValidate'];
  readonly crossValidateChanges?: SyncEngineOptions<Scope>['crossValidateChanges'];
}

export interface RemelonSyncAsyncOptions<Scope> {
  readonly imports?: DynamicModule['imports'];
  readonly inject?: FactoryProvider['inject'];
  readonly useFactory: (
    ...args: never[]
  ) => RemelonSyncOptions<Scope> | Promise<RemelonSyncOptions<Scope>>;
}

/**
 * What the module provides under {@link REMELON_SYNC}: the prepared
 * engine + validation behind the controller. Injectable by apps that
 * want the runtime without the bundled controller.
 * @category Transport
 */
export interface SyncRuntime {
  /**
   * The request's principal with the 401 gate applied: an unusable
   * scope throws instead of resolving. `pull` and `push` re-check the
   * scope they are handed, so a caller that skips this cannot sync
   * anonymously.
   */
  scopeFrom(request: unknown): Promise<unknown>;
  pull(scope: unknown, body: unknown): Promise<SyncPullResult>;
  push(scope: unknown, body: unknown): Promise<SyncPushResult>;
}

export const REMELON_SYNC = Symbol('remelondb sync runtime');

/** The module's engine configuration: everything except the transport concern. */
export type SyncEngineConfig<Scope> = Omit<
  RemelonSyncOptions<Scope>,
  'scopeFrom'
>;

/**
 * Build the exact engine {@link RemelonSyncModule} would build from the
 * same options — for tests, scripts, and non-Nest usage. Share one
 * config object between this and `forRoot`/`forRootAsync` and the two
 * paths cannot drift.
 */
export function syncEngineFromOptions<Scope>(
  options: SyncEngineConfig<Scope>,
): ReturnType<typeof createSyncEngine<Scope>> {
  const wire = syncSchemas(options.tables);
  return createSyncEngine<Scope>({
    store: options.store,
    tables: Object.fromEntries(
      Object.keys(options.tables).map((name) => [
        name,
        {
          ...options.tableOptions?.[name],
          validate: (row: unknown) =>
            wire.localRows[name]?.safeParse(row).success === true,
        },
      ]),
    ),
    ...(options.crossValidate ? { crossValidate: options.crossValidate } : {}),
    ...(options.crossValidateChanges
      ? { crossValidateChanges: options.crossValidateChanges }
      : {}),
  });
}

// An unusable scope must never reach the store: memoryStore buckets
// `undefined` into one shared scope, so an anonymous pull would serve
// the previous anonymous push. `== null` alone would admit `''`.
const gate = (scope: unknown): void => {
  if (scope === null || scope === undefined || scope === '') {
    throw new UnauthorizedException();
  }
};

const prepare = <Scope>(options: RemelonSyncOptions<Scope>): SyncRuntime => {
  const wire = syncSchemas(options.tables);
  const engine = syncEngineFromOptions(options);
  // The push envelope validates shape and usable ids only; the strict
  // per-table schemas run in the engine, where an invalid record is
  // rejected BY ID while the rest of the push applies (conformance
  // item 7). Wire-validating values here would 400 the whole batch.
  const id = z.string().min(1);
  const looseRow = z.looseObject({ id });
  const changeSet = z.strictObject({
    created: z.array(looseRow),
    updated: z.array(looseRow),
    deleted: z.array(id),
  });
  const pushEnvelope = z.strictObject({
    changes: z
      .strictObject(
        Object.fromEntries(
          Object.keys(options.tables).map((name) => [name, changeSet]),
        ),
      )
      .partial(),
    cursor: z.string().min(1),
  });
  return {
    scopeFrom: async (request) => {
      const scope = await options.scopeFrom(request);
      gate(scope);
      return scope;
    },
    pull: async (scope, body) => {
      const resolvedScope = await scope;
      gate(resolvedScope);
      const parsed = wire.pullArgs.safeParse(body);
      if (!parsed.success)
        throw new BadRequestException('malformed pull request');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SyncRuntime erases Scope; this value came from this closure's scopeFrom.
      const scoped = engine.as(resolvedScope as Scope);
      return wire.pullResult.encode(await scoped.pull(parsed.data));
    },
    push: async (scope, body) => {
      const resolvedScope = await scope;
      gate(resolvedScope);
      const parsed = pushEnvelope.safeParse(body);
      if (!parsed.success)
        throw new BadRequestException('malformed push request');
      try {
        const changes: Record<
          string,
          { created: DirtyRaw[]; updated: DirtyRaw[]; deleted: string[] }
        > = {};
        for (const [table, change] of Object.entries(parsed.data.changes)) {
          if (!change) continue;
          const decode = (row: DirtyRaw): DirtyRaw => {
            const result = wire.rows[table]?.safeParse(row);
            return result?.success ? result.data : row;
          };
          changes[table] = {
            created: change.created.map(decode),
            updated: change.updated.map(decode),
            deleted: change.deleted,
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- as above: SyncRuntime erases Scope, the value came from this closure's scopeFrom.
        const scoped = engine.as(resolvedScope as Scope);
        const result = await scoped.push({ ...parsed.data, changes });
        return wire.pushResult.encode(result);
      } catch (error) {
        if (error instanceof SyncProtocolError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    },
  };
};

@Controller('sync')
export class RemelonSyncController {
  constructor(@Inject(REMELON_SYNC) private readonly sync: SyncRuntime) {}

  @Post('pull')
  @HttpCode(200)
  async pull(
    @Req() request: unknown,
    @Body() body: unknown,
  ): Promise<SyncPullResult> {
    return this.sync.pull(await this.sync.scopeFrom(request), body);
  }

  @Post('push')
  @HttpCode(200)
  async push(
    @Req() request: unknown,
    @Body() body: unknown,
  ): Promise<SyncPushResult> {
    return this.sync.push(await this.sync.scopeFrom(request), body);
  }
}

@Module({})
// A Nest module is a class with static factories by construction; there is
// nothing to instantiate.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class RemelonSyncModule {
  static forRoot<Scope>(options: RemelonSyncOptions<Scope>): DynamicModule {
    return {
      module: RemelonSyncModule,
      controllers: [RemelonSyncController],
      providers: [{ provide: REMELON_SYNC, useValue: prepare(options) }],
    };
  }

  static forRootAsync<Scope>(
    options: RemelonSyncAsyncOptions<Scope>,
  ): DynamicModule {
    return {
      module: RemelonSyncModule,
      ...(options.imports ? { imports: options.imports } : {}),
      controllers: [RemelonSyncController],
      providers: [
        {
          provide: REMELON_SYNC,
          ...(options.inject ? { inject: options.inject } : {}),
          useFactory: async (...args: never[]) =>
            prepare(await options.useFactory(...args)),
        },
      ],
    };
  }
}
