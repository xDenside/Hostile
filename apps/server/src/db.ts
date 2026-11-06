import { createHash } from 'node:crypto';
import fs, {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { NodeFS } from '@electric-sql/pglite/nodefs';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from './generated/prisma/client.js';

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export interface Database {
  db: Db;
  applied: string[];
  close(): Promise<void>;
}

export class DatabaseInUseError extends Error {
  constructor(
    public readonly lockFile: string,
    public readonly pid: number,
  ) {
    super(
      `The data folder is in use by process ${pid}, and two processes on one folder would corrupt it. ` +
        `Stop that process. If no Hostile server is running, delete ${lockFile}.`,
    );
    this.name = 'DatabaseInUseError';
  }
}

export class MigrationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationMismatchError';
  }
}

const START_PARAMS = [
  ...PGlite.defaultStartParams.filter((param) => param !== '-F'),
  '-c',
  'wal_sync_method=fsync',
  '-c',
  'TimeZone=UTC',
  '-c',
  'shared_buffers=16MB',
  '-c',
  'wal_buffers=1MB',
  '-c',
  'work_mem=2MB',
  '-c',
  'maintenance_work_mem=16MB',
  '-c',
  'min_wal_size=32MB',
  '-c',
  'max_wal_size=128MB',
];

class DurableNodeFS extends NodeFS {
  override async init(
    pg: Parameters<NodeFS['init']>[0],
    options: Parameters<NodeFS['init']>[1],
  ): ReturnType<NodeFS['init']> {
    const result = await super.init(pg, options);
    const { preRun = [] } = result.emscriptenOpts;
    result.emscriptenOpts = {
      ...result.emscriptenOpts,
      preRun: [
        ...preRun,
        (mod: EmscriptenModule) => {
          const nodefs = mod.FS.filesystems.NODEFS;
          nodefs.stream_ops.fsync = (stream: EmscriptenStream) => {
            if (stream.nfd !== undefined) {
              fs.fsyncSync(stream.nfd);
              return 0;
            }
            const fd = fs.openSync(nodefs.realPath(stream.node), 'r');
            try {
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            return 0;
          };
        },
      ],
    };
    return result;
  }
}

interface EmscriptenStream {
  nfd?: number;
  node: unknown;
}
interface EmscriptenModule {
  FS: {
    filesystems: {
      NODEFS: {
        stream_ops: { fsync?: (stream: EmscriptenStream) => number };
        realPath(node: unknown): string;
      };
    };
  };
}

function open(dir: string): PGlite {
  return new PGlite({ fs: new DurableNodeFS(dir), startParams: START_PARAMS });
}

async function createIfMissing(dir: string): Promise<void> {
  if (existsSync(join(dir, 'PG_VERSION'))) return;
  if (existsSync(dir) && readdirSync(dir).length) {
    throw new Error(`${dir} holds files but no database. Move them away and start again.`);
  }
  const creating = `${dir}.creating`;
  rmSync(creating, { recursive: true, force: true });
  const pg = open(creating);
  await pg.waitReady;
  await pg.close();
  rmSync(dir, { recursive: true, force: true });
  renameSync(creating, dir);
}

const bootTime = () => Math.round(Date.now() / 1000 - uptime());
const SAME_BOOT_SECONDS = 60;

function lockIsStale(lock: { pid: number; boot: number }): boolean {
  if (Math.abs(lock.boot - bootTime()) > SAME_BOOT_SECONDS) return true;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EPERM';
  }
}

function acquireLock(lockFile: string): () => void {
  const contents = JSON.stringify({ pid: process.pid, boot: bootTime() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockFile, contents, { flag: 'wx', mode: 0o600 });
      return () => rmSync(lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let lock: { pid: number; boot: number } | null = null;
    try {
      lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    } catch {}
    if (lock && !lockIsStale(lock)) throw new DatabaseInUseError(lockFile, lock.pid);
    rmSync(lockFile, { force: true });
  }
  throw new DatabaseInUseError(lockFile, 0);
}

function defaultMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'prisma', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('prisma/migrations was not found; set MIGRATIONS_DIR.');
    dir = parent;
  }
}

function readMigrations(dir: string): { name: string; sql: string; checksum: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

async function applyMigrations(pg: PGlite, dir: string): Promise<string[]> {
  await pg.exec(`CREATE TABLE IF NOT EXISTS "_schema_migrations" (
    "name" TEXT PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await pg.query<{ name: string; checksum: string }>(
    'SELECT "name", "checksum" FROM "_schema_migrations"',
  );
  const known = new Map(rows.map((row) => [row.name, row.checksum]));
  const migrations = readMigrations(dir);

  const unknown = rows.filter((row) => !migrations.some((m) => m.name === row.name));
  if (unknown.length) {
    throw new MigrationMismatchError(
      `This database was written by a newer version of the app (${unknown.map((u) => u.name).join(', ')}). Update the app.`,
    );
  }
  const applied: string[] = [];
  for (const { name, sql, checksum } of migrations) {
    const done = known.get(name);
    if (done === checksum) continue;
    if (done) throw new MigrationMismatchError(`Migration ${name} changed after it was applied.`);
    await pg.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO "_schema_migrations" ("name", "checksum") VALUES ($1, $2)', [
        name,
        checksum,
      ]);
    });
    applied.push(name);
  }
  return applied;
}

interface OpenFolder {
  pg: PGlite;
  applied: string[];
  releaseLock: () => void;
  users: number;
}

const openFolders = new Map<string, Promise<OpenFolder>>();

export async function openDatabase(
  dataDir: string,
  options: { migrationsDir?: string } = {},
): Promise<Database> {
  const root = resolve(dataDir);
  let opening = openFolders.get(root);
  const first = !opening;
  if (!opening) {
    opening = (async () => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const releaseLock = acquireLock(join(root, 'db.lock'));
      try {
        const dir = join(root, 'db');
        await createIfMissing(dir);
        const pg = open(dir);
        await pg.waitReady;
        const applied = await applyMigrations(pg, options.migrationsDir ?? defaultMigrationsDir());
        await pg.exec('VACUUM ANALYZE');
        return { pg, applied, releaseLock, users: 0 };
      } catch (err) {
        releaseLock();
        throw err;
      }
    })();
    openFolders.set(root, opening);
  }
  let folder: OpenFolder;
  try {
    folder = await opening;
  } catch (err) {
    openFolders.delete(root);
    throw err;
  }
  folder.users += 1;

  const db = new PrismaClient({ adapter: new PrismaPGlite(folder.pg) });
  let closed = false;
  return {
    db,
    applied: first ? folder.applied : [],
    close: async () => {
      if (closed) return;
      closed = true;
      await db.$disconnect();
      folder.users -= 1;
      if (folder.users > 0) return;
      openFolders.delete(root);
      try {
        await folder.pg.close();
      } finally {
        folder.releaseLock();
      }
    },
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
