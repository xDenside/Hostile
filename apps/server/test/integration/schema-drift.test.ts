import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDatabase, type Database } from '../../src/db.js';

const SCALARS: Record<string, string[]> = {
  String: ['text', 'uuid', 'character varying'],
  Int: ['integer', 'smallint'],
  BigInt: ['bigint'],
  Boolean: ['boolean'],
  DateTime: ['timestamp with time zone', 'timestamp without time zone', 'date'],
  Json: ['jsonb', 'json'],
  Float: ['double precision'],
  Bytes: ['bytea'],
};

interface ExpectedColumn {
  name: string;
  nullable: boolean;
  types: string[];
}
interface ExpectedTable {
  columns: ExpectedColumn[];
  indexes: string[];
}

function readSchema(text: string) {
  const enums = new Map<string, string[]>();
  const tables = new Map<string, ExpectedTable>();
  const lines = (body: string) =>
    body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter(Boolean);
  for (const [, name, body] of text.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
    enums.set(name!, lines(body!));
  }
  const models = new Set([...text.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!));
  for (const [, model, body] of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const columns: ExpectedColumn[] = [];
    const indexes: string[] = [];
    const columnName = new Map<string, string>();
    let table = model!;
    const blockAttributes: string[] = [];
    for (const line of lines(body!)) {
      if (line.startsWith('@@')) {
        blockAttributes.push(line);
        continue;
      }
      const [, field, type, mark, rest] = /^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)$/.exec(line)!;
      if (models.has(type!) || rest!.includes('@relation')) continue;
      const column = /@map\("([^"]+)"\)/.exec(rest!)?.[1] ?? field!;
      columnName.set(field!, column);
      const types = enums.has(type!)
        ? ['USER-DEFINED']
        : mark === '[]'
          ? ['ARRAY']
          : (SCALARS[type!] ?? [`unknown:${type}`]);
      columns.push({ name: column, nullable: mark === '?', types });
      if (/@unique\b/.test(rest!)) indexes.push(column);
    }
    for (const attribute of blockAttributes) {
      const map = /^@@map\("([^"]+)"\)/.exec(attribute);
      if (map) table = map[1]!;
      const index = /^@@(?:index|unique)\(\s*(?:fields:\s*)?\[([^\]]+)\]/.exec(attribute);
      if (index) {
        const names = index[1]!.split(',').map((part) => part.trim().split(/[\s(]/)[0]!);
        indexes.push(names.map((name) => columnName.get(name) ?? name).join(','));
      }
    }
    tables.set(table, { columns, indexes });
  }
  return { enums, tables };
}

interface Actual {
  columns: Map<string, Map<string, { nullable: boolean; type: string }>>;
  indexes: Map<string, string[]>;
  enums: Map<string, string[]>;
}

async function readDatabase(database: Database): Promise<Actual> {
  const { db } = database;
  const columns: Actual['columns'] = new Map();
  for (const row of await db.$queryRawUnsafe<
    { table_name: string; column_name: string; is_nullable: string; data_type: string }[]
  >(
    `SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns
     WHERE table_schema = 'public'`,
  )) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, new Map());
    columns.get(row.table_name)!.set(row.column_name, {
      nullable: row.is_nullable === 'YES',
      type: row.data_type,
    });
  }
  const indexes: Actual['indexes'] = new Map();
  for (const row of await db.$queryRawUnsafe<{ table_name: string; columns: string }[]>(
    `SELECT t.relname AS table_name, string_agg(a.attname, ',' ORDER BY k.ord) AS columns
     FROM pg_index i
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE NOT i.indisprimary
     GROUP BY i.indexrelid, t.relname`,
  )) {
    if (!indexes.has(row.table_name)) indexes.set(row.table_name, []);
    indexes.get(row.table_name)!.push(row.columns);
  }
  const enums: Actual['enums'] = new Map();
  for (const row of await db.$queryRawUnsafe<{ name: string; value: string }[]>(
    `SELECT t.typname AS name, e.enumlabel AS value FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid ORDER BY e.enumsortorder`,
  )) {
    if (!enums.has(row.name)) enums.set(row.name, []);
    enums.get(row.name)!.push(row.value);
  }
  return { columns, indexes, enums };
}

function compare(expected: ReturnType<typeof readSchema>, actual: Actual): string[] {
  const out: string[] = [];
  const ignored = /^_prisma_migrations$|^_migrations$|migration/i;
  for (const table of actual.columns.keys()) {
    if (!expected.tables.has(table) && !ignored.test(table)) {
      out.push(`table ${table} is in the migrations but not in schema.prisma`);
    }
  }
  for (const [table, want] of expected.tables) {
    const have = actual.columns.get(table);
    if (!have) {
      out.push(`table ${table} is in schema.prisma but not in the migrations`);
      continue;
    }
    for (const column of want.columns) {
      const found = have.get(column.name);
      if (!found) {
        out.push(`${table}.${column.name} is in schema.prisma but not in the migrations`);
        continue;
      }
      if (found.nullable !== column.nullable)
        out.push(`${table}.${column.name}: nullable differs, migrations say ${found.nullable}`);
      if (!column.types.includes(found.type))
        out.push(`${table}.${column.name}: type ${found.type} is not one of ${column.types}`);
    }
    for (const name of have.keys()) {
      if (!want.columns.some((column) => column.name === name))
        out.push(`${table}.${name} is in the migrations but not in schema.prisma`);
    }
    const haveIndexes = [...(actual.indexes.get(table) ?? [])].sort();
    const wantIndexes = [...want.indexes].sort();
    for (const index of wantIndexes) {
      if (!haveIndexes.includes(index))
        out.push(`${table}: index on (${index}) is in schema.prisma but not in the migrations`);
    }
    for (const index of haveIndexes) {
      if (!wantIndexes.includes(index))
        out.push(`${table}: index on (${index}) is in the migrations but not in schema.prisma`);
    }
  }
  for (const [name, values] of expected.enums) {
    if (actual.enums.get(name)?.join() !== values.join())
      out.push(`enum ${name}: migrations have ${actual.enums.get(name)}, schema has ${values}`);
  }
  return out;
}

describe('schema.prisma and the migrations', () => {
  const schema = readFileSync(resolve(import.meta.dirname, '../../prisma/schema.prisma'), 'utf8');
  const folder = mkdtempSync(join(tmpdir(), 'hostile-drift-'));
  let database: Database;
  let actual: Actual;

  beforeAll(async () => {
    database = await openDatabase(folder);
    actual = await readDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  test('describe the same database', () => {
    expect(compare(readSchema(schema), actual)).toEqual([]);
  });

  test('a drift of any kind would be noticed', () => {
    const user = /^model User \{[\s\S]*?^\}/m.exec(schema)![0];
    const drifted = [
      user.replace(/^\}/m, '  brandNew String\n}'),
      user.replace(/^(\s+displayName\s+String)/m, '$1?'),
      user.replace(/^\}/m, '  @@index([displayName, id])\n}'),
    ];
    for (const model of drifted) {
      expect(model).not.toBe(user);
      expect(compare(readSchema(schema.replace(user, model)), actual).length).toBeGreaterThan(0);
    }
    const lost = schema.replace(user, user.replace(/^\s+displayName\s.*$/m, ''));
    expect(compare(readSchema(lost), actual).join()).toContain('in the migrations but not in');
  });
});
