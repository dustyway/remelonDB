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
} from '@nestjs/common'
import type { DynamicModule, FactoryProvider } from '@nestjs/common'
import { z } from 'zod'
import type { SyncPullArgs, SyncPullResult, SyncPushArgs, SyncPushResult } from '@remelondb/core'
import { syncSchemas } from '@remelondb/core/zod'
import { createSyncEngine, SyncProtocolError } from '@remelondb/server'
import type { SyncEngineOptions, SyncStore, TableConfig } from '@remelondb/server'

export interface RemelonSyncOptions<Scope> {
  readonly store: SyncStore<Scope>
  /** Per-table Zod objects — the same ones the client's zodTable uses. */
  readonly tables: { readonly [table: string]: z.ZodObject<z.ZodRawShape> }
  /**
   * Per-table engine config beyond validation (e.g. `appendOnly`).
   * Validation always comes from {@link tables}; it cannot be
   * overridden here.
   */
  readonly tableOptions?: {
    readonly [table: string]: Omit<TableConfig, 'validate'>
  }
  /**
   * The authenticated principal for a request (e.g. the session's user
   * id); null/undefined answers 401. Auth itself stays the app's.
   */
  readonly scopeFrom: (
    request: unknown,
  ) => Scope | null | undefined | Promise<Scope | null | undefined>
  readonly crossValidate?: SyncEngineOptions<Scope>['crossValidate']
  readonly crossValidateChanges?: SyncEngineOptions<Scope>['crossValidateChanges']
}

export interface RemelonSyncAsyncOptions<Scope> {
  readonly imports?: DynamicModule['imports']
  readonly inject?: FactoryProvider['inject']
  readonly useFactory: (
    ...args: never[]
  ) => RemelonSyncOptions<Scope> | Promise<RemelonSyncOptions<Scope>>
}

/**
 * What the module provides under {@link REMELON_SYNC}: the prepared
 * engine + validation behind the controller. Injectable by apps that
 * want the runtime without the bundled controller.
 * @category Transport
 */
export interface SyncRuntime {
  scopeFrom(request: unknown): unknown
  pull(scope: unknown, body: unknown): Promise<SyncPullResult>
  push(scope: unknown, body: unknown): Promise<SyncPushResult>
}

export const REMELON_SYNC = Symbol('remelondb sync runtime')

/** The module's engine configuration: everything except the transport concern. */
export type SyncEngineConfig<Scope> = Omit<RemelonSyncOptions<Scope>, 'scopeFrom'>

/**
 * Build the exact engine {@link RemelonSyncModule} would build from the
 * same options — for tests, scripts, and non-Nest usage. Share one
 * config object between this and `forRoot`/`forRootAsync` and the two
 * paths cannot drift.
 */
export function syncEngineFromOptions<Scope>(
  options: SyncEngineConfig<Scope>,
): ReturnType<typeof createSyncEngine<Scope>> {
  const wire = syncSchemas(options.tables)
  return createSyncEngine<Scope>({
    store: options.store,
    tables: Object.fromEntries(
      Object.keys(options.tables).map((name) => [
        name,
        {
          ...options.tableOptions?.[name],
          validate: (row: unknown) => wire.rows[name]!.safeParse(row).success,
        },
      ]),
    ),
    ...(options.crossValidate ? { crossValidate: options.crossValidate } : {}),
    ...(options.crossValidateChanges
      ? { crossValidateChanges: options.crossValidateChanges }
      : {}),
  })
}

const prepare = <Scope>(options: RemelonSyncOptions<Scope>): SyncRuntime => {
  const wire = syncSchemas(options.tables)
  const engine = syncEngineFromOptions(options)
  // The push envelope validates shape and usable ids only; the strict
  // per-table schemas run in the engine, where an invalid record is
  // rejected BY ID while the rest of the push applies (conformance
  // item 7). Wire-validating values here would 400 the whole batch.
  const id = z.string().min(1)
  const looseRow = z.looseObject({ id })
  const changeSet = z.strictObject({
    created: z.array(looseRow),
    updated: z.array(looseRow),
    deleted: z.array(id),
  })
  const pushEnvelope = z.strictObject({
    changes: z
      .strictObject(Object.fromEntries(Object.keys(options.tables).map((name) => [name, changeSet])))
      .partial(),
    cursor: z.string().min(1),
  })
  return {
    scopeFrom: (request) => options.scopeFrom(request),
    pull: (scope, body) => {
      const parsed = wire.pullArgs.safeParse(body)
      if (!parsed.success) throw new BadRequestException('malformed pull request')
      return engine.as(scope as Scope).pull(parsed.data as SyncPullArgs)
    },
    push: async (scope, body) => {
      const parsed = pushEnvelope.safeParse(body)
      if (!parsed.success) throw new BadRequestException('malformed push request')
      try {
        return await engine.as(scope as Scope).push(parsed.data as SyncPushArgs)
      } catch (error) {
        if (error instanceof SyncProtocolError) {
          throw new BadRequestException(error.message)
        }
        throw error
      }
    },
  }
}

@Controller('sync')
export class RemelonSyncController {
  constructor(@Inject(REMELON_SYNC) private readonly sync: SyncRuntime) {}

  @Post('pull')
  @HttpCode(200)
  async pull(@Req() request: unknown, @Body() body: unknown): Promise<SyncPullResult> {
    const scope = await this.sync.scopeFrom(request)
    if (scope == null) throw new UnauthorizedException()
    return this.sync.pull(scope, body)
  }

  @Post('push')
  @HttpCode(200)
  async push(@Req() request: unknown, @Body() body: unknown): Promise<SyncPushResult> {
    const scope = await this.sync.scopeFrom(request)
    if (scope == null) throw new UnauthorizedException()
    return this.sync.push(scope, body)
  }
}

@Module({})
export class RemelonSyncModule {
  static forRoot<Scope>(options: RemelonSyncOptions<Scope>): DynamicModule {
    return {
      module: RemelonSyncModule,
      controllers: [RemelonSyncController],
      providers: [{ provide: REMELON_SYNC, useValue: prepare(options) }],
    }
  }

  static forRootAsync<Scope>(options: RemelonSyncAsyncOptions<Scope>): DynamicModule {
    return {
      module: RemelonSyncModule,
      ...(options.imports ? { imports: options.imports } : {}),
      controllers: [RemelonSyncController],
      providers: [
        {
          provide: REMELON_SYNC,
          ...(options.inject ? { inject: options.inject } : {}),
          useFactory: async (...args: never[]) => prepare(await options.useFactory(...args)),
        },
      ],
    }
  }
}
