/**
 * Schema-aware SQL completion. Keyword completion is lang-sql's own `keywordCompletionSource`;
 * the schema part (databases, tables, columns of the statement's tables, `x.` members) replaces
 * lang-sql's `schemaCompletionSource`, which knows neither column types nor other databases'
 * schemas and only reads aliases from the top-level `FROM`.
 */

import {
  completionStatus,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete"
import { keywordCompletionSource, MySQL, PostgreSQL, type SQLDialect } from "@codemirror/lang-sql"
import type { EditorState, Text } from "@codemirror/state"
import type { SchemaSnapshot } from "../../../lib/mysql"
import { MYSQL_SYNTAX, type SqlSyntax } from "../../../lib/sqlContext"
import { MYSQL_DIALECT, type EditorDialect, type SqlDialect } from "../../../lib/sqlDialect"
import {
  cursorContext,
  type CompletionWord,
  type CursorContext,
  type TableRef,
} from "../../../lib/sqlScope"
import {
  BOOST,
  columnOptions,
  databaseOptions,
  findTable,
  resolveDatabase,
  tableOptions,
  withExactMatchBoost,
  type SchemaCatalog,
} from "./catalog"

export interface CompletionEnv {
  /** Tokenizing and quoting rules of the editor's engine; MySQL when absent. */
  dialect?: SqlDialect
  catalog(): SchemaCatalog
  /**
   * Starts loading the schema of `database` and resolves once it settled (loaded or failed).
   * Null when there is nothing to wait for: already loaded, unknown, offline, or failed recently.
   */
  requestSchema(database: string): Promise<void> | null
}

export interface SchemaSourceOptions {
  /**
   * Runs when a schema the source asked for has loaded, with the latest request that needed it.
   * Defaults to reopening the completion list if the cursor is still on the same word.
   */
  onSchemaLoaded?: (context: CompletionContext, wordFrom: number) => void
}

type NamedContext = Exclude<CursorContext, { kind: "none" }>
type SchemaLookup = (database: string) => SchemaSnapshot | null

let lastAnalysis: {
  doc: Text
  pos: number
  syntax: SqlSyntax
  context: CursorContext
} | null = null

/** Cursor context of `state` at `pos`; both sources ask for it on every keystroke. */
export function contextAt(
  state: EditorState,
  pos: number,
  syntax: SqlSyntax = MYSQL_SYNTAX,
): CursorContext {
  const last = lastAnalysis
  if (last && last.doc === state.doc && last.pos === pos && last.syntax === syntax) {
    return last.context
  }
  const context = cursorContext(state.doc.toString(), pos, syntax)
  lastAnalysis = { doc: state.doc, pos, syntax, context }
  return context
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The table a qualifier names: an alias first, then an unaliased table of the statement. */
function scopeRefFor(tables: readonly TableRef[], name: string): TableRef | null {
  return (
    tables.find((t) => t.alias !== null && sameName(t.alias, name)) ??
    tables.find((t) => t.alias === null && t.table !== null && sameName(t.table, name)) ??
    null
  )
}

/** What option builders read: the catalog, a schema lookup and the dialect's quoting. */
interface Lookup {
  catalog: SchemaCatalog
  schemaOf: SchemaLookup
  dialect: SqlDialect
}

/** Columns of the table `ref` points at; null when unknown or still loading. */
function refColumns(ref: TableRef, lookup: Lookup): readonly Completion[] | null {
  const { catalog, schemaOf, dialect } = lookup
  if (ref.table === null) return null
  const database = ref.database ? resolveDatabase(catalog, ref.database) : catalog.currentDatabase
  const snapshot = database ? schemaOf(database) : null
  const table = snapshot ? findTable(snapshot, ref.table, dialect) : null
  return snapshot && table ? columnOptions(snapshot, table, dialect) : null
}

function memberOptions(
  parents: readonly string[],
  tables: readonly TableRef[],
  lookup: Lookup,
): readonly Completion[] | null {
  if (parents.length === 2) {
    const [db, table] = parents as [string, string]
    return refColumns({ database: db, table, alias: null }, lookup)
  }
  if (parents.length !== 1) return null
  const name = parents[0] as string
  const ref = scopeRefFor(tables, name)
  if (ref) return refColumns(ref, lookup)
  const database = resolveDatabase(lookup.catalog, name)
  if (database) {
    const snapshot = lookup.schemaOf(database)
    return snapshot ? tableOptions(snapshot, lookup.dialect) : null
  }
  // A table of the current database that the statement doesn't mention (yet).
  return refColumns({ database: null, table: name, alias: null }, lookup)
}

/** Columns of every table the statement reads, each table once. */
function scopeColumns(tables: readonly TableRef[], lookup: Lookup): Completion[] {
  const seen = new Set<readonly Completion[]>()
  const lists: (readonly Completion[])[] = []
  for (const ref of tables) {
    const columns = refColumns(ref, lookup)
    if (columns && !seen.has(columns)) {
      seen.add(columns)
      lists.push(columns)
    }
  }
  return lists.flat()
}

function aliasOptions(tables: readonly TableRef[]): Completion[] {
  return tables.flatMap((ref) =>
    ref.alias === null
      ? []
      : [
          {
            label: ref.alias,
            type: "variable",
            detail: ref.table === null ? "alias" : `alias · ${ref.table}`,
            boost: BOOST.alias,
          },
        ],
  )
}

function positionOptions(
  context: Exclude<NamedContext, { kind: "member" }>,
  lookup: Lookup,
): readonly Completion[] | null {
  const { catalog, schemaOf, dialect } = lookup
  const current = catalog.currentDatabase ? schemaOf(catalog.currentDatabase) : null
  const tables = current ? tableOptions(current, dialect) : []
  const databases = databaseOptions(catalog.databases, dialect)
  switch (context.kind) {
    case "keyword":
      return null
    case "database":
      return databases
    case "table":
    case "other":
      return [...tables, ...databases]
    case "column":
      return [
        ...scopeColumns(context.tables, lookup),
        ...aliasOptions(context.tables),
        ...tables,
        ...databases,
      ]
  }
}

/** Exact-match boost, and quoted labels when the word was started with an identifier quote. */
function finalize(
  options: readonly Completion[],
  word: CompletionWord,
  dialect: SqlDialect,
): Completion[] {
  return options.map((option) => {
    const boosted = withExactMatchBoost(option, word.text)
    return word.quoted
      ? { ...boosted, label: dialect.quoteIdentifier(boosted.label), apply: undefined }
      : boosted
  })
}

/** Characters of a (possibly qualified, possibly quoted) name in either dialect. */
const IDENTIFIER_RUN = /^[\p{L}\p{N}_$`".]*$/u
const MAX_WORD_LENGTH = 256

/** Reopens the list when the cursor is still on the word the loaded schema was needed for. */
export function reopenCompletion(context: CompletionContext, wordFrom: number): void {
  const view = context.view
  if (!view || !view.dom.isConnected) return
  const { main } = view.state.selection
  if (!main.empty || main.head < wordFrom || main.head - wordFrom > MAX_WORD_LENGTH) return
  if (!IDENTIFIER_RUN.test(view.state.sliceDoc(wordFrom, main.head))) return
  if (completionStatus(view.state) === "pending") return
  startCompletion(view)
}

/** Completion of databases, tables and columns from the session's schema cache. */
export function schemaCompletionSource(
  env: CompletionEnv,
  { onSchemaLoaded = reopenCompletion }: SchemaSourceOptions = {},
): CompletionSource {
  /** Latest request waiting on each schema load; a load reopens the list once, for it. */
  const waiting = new Map<Promise<void>, { context: CompletionContext; wordFrom: number }>()

  const awaitSchemas = (
    databases: ReadonlySet<string>,
    context: CompletionContext,
    wordFrom: number,
  ) => {
    for (const database of databases) {
      const request = env.requestSchema(database)
      if (!request) continue
      const known = waiting.has(request)
      waiting.set(request, { context, wordFrom })
      if (known) continue
      void request.then(() => {
        const latest = waiting.get(request)
        waiting.delete(request)
        if (latest) onSchemaLoaded(latest.context, latest.wordFrom)
      })
    }
  }

  const dialect = env.dialect ?? MYSQL_DIALECT
  return (context): CompletionResult | null => {
    const cursor = contextAt(context.state, context.pos, dialect.syntax)
    if (cursor.kind === "none" || cursor.kind === "keyword") return null
    const { word } = cursor
    if (cursor.kind !== "member" && word.text === "" && !word.quoted && !context.explicit) {
      return null
    }
    const catalog = env.catalog()
    const missing = new Set<string>()
    const schemaOf: SchemaLookup = (database) => {
      const snapshot = catalog.schemas[database]
      if (!snapshot) missing.add(database)
      return snapshot ?? null
    }
    const lookup: Lookup = { catalog, schemaOf, dialect }
    const options =
      cursor.kind === "member"
        ? memberOptions(cursor.parents, cursor.tables, lookup)
        : positionOptions(cursor, lookup)
    awaitSchemas(missing, context, word.from)
    if (!options || options.length === 0) return null
    return {
      from: word.from,
      ...(word.to > context.pos ? { to: word.to } : {}),
      options: finalize(options, word, dialect),
    }
  }
}

const EDITOR_DIALECTS: Record<EditorDialect, SQLDialect> = { mysql: MySQL, postgresql: PostgreSQL }

/** lang-sql's keywords for `dialect`, kept out of `x.` members, strings and comments. */
export function keywordSource(dialect: SqlDialect = MYSQL_DIALECT): CompletionSource {
  const keywords = keywordCompletionSource(EDITOR_DIALECTS[dialect.editor], true)
  return (context) => {
    const cursor = contextAt(context.state, context.pos, dialect.syntax)
    if (cursor.kind === "none" || cursor.kind === "member") return null
    return keywords(context)
  }
}

/** Sources for `autocompletion({ override })`: schema names first, then keywords. */
export function sqlCompletionSources(
  env: CompletionEnv,
  options?: SchemaSourceOptions,
): readonly CompletionSource[] {
  return [schemaCompletionSource(env, options), keywordSource(env.dialect)]
}
