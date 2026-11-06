import { spawn } from 'node:child_process';
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { DatabaseInUseError, MigrationMismatchError, openDatabase } from '../../src/db.js';

const MIGRATIONS = resolve(import.meta.dirname, '../../prisma/migrations');
const COUNT = fs.readdirSync(MIGRATIONS, { withFileTypes: true }).filter((e) => e.isDirectory());

let parent: string;
beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'hostile-database-'));
});
afterAll(() => rmSync(parent, { recursive: true, force: true }));

let next = 0;
const newFolder = () => join(parent, `room-${(next += 1)}`);

function copyMigrations(): string {
  const dir = join(newFolder(), 'migrations');
  cpSync(MIGRATIONS, dir, { recursive: true });
  return dir;
}

function addMigration(dir: string, name: string, sql: string) {
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, 'migration.sql'), sql);
}

const tableExists = async (db: Awaited<ReturnType<typeof openDatabase>>['db'], table: string) => {
  const rows = await db.$queryRaw<{ found: boolean }[]>`
    SELECT to_regclass(${`public."${table}"`}) IS NOT NULL AS found`;
  return rows[0]!.found;
};

describe('migrations', () => {
  test('the first open creates the database and applies them all, the next applies none', async () => {
    const folder = newFolder();
    const first = await openDatabase(folder);
    expect(first.applied).toHaveLength(COUNT.length);
    expect(await tableExists(first.db, 'users')).toBe(true);
    await first.db.channel.create({ data: { name: 'kept', type: 'TEXT', position: 0 } });
    await first.close();

    const second = await openDatabase(folder);
    expect(second.applied).toEqual([]);
    expect(await second.db.channel.count({ where: { name: 'kept' } })).toBe(1);
    await second.close();
  });

  test('a later open applies only what is new', async () => {
    const folder = newFolder();
    const migrationsDir = copyMigrations();
    await (await openDatabase(folder, { migrationsDir })).close();

    addMigration(migrationsDir, '20991231000000_new', 'CREATE TABLE "later" ("id" INTEGER);');
    const database = await openDatabase(folder, { migrationsDir });
    expect(database.applied).toEqual(['20991231000000_new']);
    expect(await tableExists(database.db, 'later')).toBe(true);
    await database.close();
  });

  test('a migration that fails leaves nothing of itself, and blocks the start', async () => {
    const folder = newFolder();
    const migrationsDir = copyMigrations();
    await (await openDatabase(folder, { migrationsDir })).close();

    addMigration(
      migrationsDir,
      '20991231000000_broken',
      'CREATE TABLE "half" ("id" INTEGER); SELECT * FROM "no_such_table";',
    );
    await expect(openDatabase(folder, { migrationsDir })).rejects.toThrow(/no_such_table/);

    rmSync(join(migrationsDir, '20991231000000_broken'), { recursive: true });
    const database = await openDatabase(folder, { migrationsDir });
    expect(await tableExists(database.db, 'half')).toBe(false);
    await database.close();
  });

  test('refuses a migration edited after it was applied', async () => {
    const folder = newFolder();
    const migrationsDir = copyMigrations();
    await (await openDatabase(folder, { migrationsDir })).close();

    const file = join(migrationsDir, COUNT[0]!.name, 'migration.sql');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- changed`);
    await expect(openDatabase(folder, { migrationsDir })).rejects.toThrow(MigrationMismatchError);
    expect(existsSync(join(folder, 'db.lock'))).toBe(false);
  });

  test('refuses a database written by a newer version of the app', async () => {
    const folder = newFolder();
    const migrationsDir = copyMigrations();
    addMigration(migrationsDir, '20991231000000_new', 'CREATE TABLE "later" ("id" INTEGER);');
    await (await openDatabase(folder, { migrationsDir })).close();

    rmSync(join(migrationsDir, '20991231000000_new'), { recursive: true });
    await expect(openDatabase(folder, { migrationsDir })).rejects.toThrow(/newer version/);
  });
});

describe('a first run that was cut short', () => {
  test('what a kill during creation leaves is replaced', async () => {
    const folder = newFolder();
    mkdirSync(join(folder, 'db.creating', 'base'), { recursive: true });
    writeFileSync(join(folder, 'db.creating', 'junk'), 'x');

    const database = await openDatabase(folder);
    expect(database.applied).toHaveLength(COUNT.length);
    expect(existsSync(join(folder, 'db.creating'))).toBe(false);
    await database.close();
  });

  test('files that are not a database are refused and left alone', async () => {
    const folder = newFolder();
    mkdirSync(join(folder, 'db'), { recursive: true });
    writeFileSync(join(folder, 'db', 'precious'), 'x');

    await expect(openDatabase(folder)).rejects.toThrow(/holds files but no database/);
    expect(readFileSync(join(folder, 'db', 'precious'), 'utf8')).toBe('x');
    expect(existsSync(join(folder, 'db.lock'))).toBe(false);
  });
});

describe('settings a kept database needs', () => {
  afterEach(() => vi.restoreAllMocks());

  test.skipIf(process.platform === 'win32')("a new data folder is its owner's alone", async () => {
    const folder = newFolder();
    const database = await openDatabase(folder);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    await database.close();
  });

  test('fsync is on, and a commit reaches the real fsync', async () => {
    const database = await openDatabase(newFolder());
    const show = async (name: string) =>
      Object.values(
        (await database.db.$queryRawUnsafe<Record<string, string>[]>(`SHOW ${name}`))[0]!,
      )[0];
    expect(await show('fsync')).toBe('on');
    expect(await show('synchronous_commit')).toBe('on');
    expect(await show('full_page_writes')).toBe('on');
    expect(await show('wal_sync_method')).toBe('fsync');

    const fsync = vi.spyOn(fs, 'fsyncSync');
    await database.db.channel.create({ data: { name: 'synced', type: 'TEXT', position: 0 } });
    expect(fsync).toHaveBeenCalled();
    await database.close();
  });

  test('times are UTC whatever the host clock says', async () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      const database = await openDatabase(newFolder());
      const rows = await database.db.$queryRaw<{ TimeZone: string }[]>`SHOW "TimeZone"`;
      expect(rows[0]!.TimeZone).toBe('UTC');
      const before = Date.now();
      const channel = await database.db.channel.create({
        data: { name: 'clock', type: 'TEXT', position: 0 },
      });
      expect(Math.abs(channel.createdAt.getTime() - before)).toBeLessThan(60_000);
      const [own] = await database.db.$queryRaw<{ at: Date }[]>`SELECT now() AS at`;
      expect(Math.abs(own!.at.getTime() - before)).toBeLessThan(60_000);
      await database.close();
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe('one owner at a time', () => {
  const bootTime = () => Math.round(Date.now() / 1000 - uptime());
  const holdLock = (folder: string, pid: number, boot = bootTime()) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'db.lock'), JSON.stringify({ pid, boot }));
  };

  test('refuses a folder that another live process holds', async () => {
    const folder = newFolder();
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    try {
      holdLock(folder, other.pid!);
      await expect(openDatabase(folder)).rejects.toThrow(DatabaseInUseError);
      expect(existsSync(join(folder, 'db'))).toBe(false);
    } finally {
      const exited = new Promise((done) => other.once('exit', done));
      other.kill('SIGKILL');
      await exited;
    }
    const database = await openDatabase(folder);
    await database.close();
    expect(existsSync(join(folder, 'db.lock'))).toBe(false);
  });

  test('a lock from before the machine restarted means nothing, whoever has that pid now', async () => {
    const folder = newFolder();
    holdLock(folder, process.ppid, bootTime() - 3600);
    const database = await openDatabase(folder);
    await database.close();
  });

  test('a damaged lock means nothing', async () => {
    const folder = newFolder();
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'db.lock'), '');
    const database = await openDatabase(folder);
    await database.close();
  });

  test('openers in one process share the database, and the last to close ends it', async () => {
    const folder = newFolder();
    const [one, two] = await Promise.all([openDatabase(folder), openDatabase(folder)]);
    await one.db.channel.create({ data: { name: 'shared', type: 'TEXT', position: 0 } });
    await one.close();
    expect(await two.db.channel.count({ where: { name: 'shared' } })).toBe(1);
    expect(existsSync(join(folder, 'db.lock'))).toBe(true);
    await two.close();
    expect(existsSync(join(folder, 'db.lock'))).toBe(false);
  });
});

describe('one connection, many requests', () => {
  test('work outside a transaction waits for it, and a failed one lets the rest go on', async () => {
    const database = await openDatabase(newFolder());
    const { db } = database;
    const order: string[] = [];
    let releaseTx!: () => void;
    const held = new Promise<void>((done) => (releaseTx = done));
    const tx = db.$transaction(async (t) => {
      await t.channel.create({ data: { name: 'in-tx', type: 'TEXT', position: 0 } });
      await held;
      order.push('commit');
    });
    await new Promise((done) => setTimeout(done, 50));
    const outside = db.channel.count().then((n) => {
      order.push('read');
      return n;
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(order).toEqual([]);
    releaseTx();
    await tx;
    expect(await outside).toBe(1);
    expect(order).toEqual(['commit', 'read']);

    await expect(
      db.$transaction(async (t) => {
        await t.channel.create({ data: { name: 'rolled-back', type: 'TEXT', position: 0 } });
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect(await db.channel.count({ where: { name: 'rolled-back' } })).toBe(0);

    await expect(
      db.$transaction(async (t) => {
        await t.$executeRawUnsafe('SELECT * FROM "no_such_table"');
      }),
    ).rejects.toThrow();
    expect(await db.channel.count()).toBe(1);
    await database.close();
  });

  test('a burst of transactions all finish', async () => {
    const database = await openDatabase(newFolder());
    const { db } = database;
    const results = await Promise.allSettled(
      Array.from({ length: 300 }, (_, i) =>
        db.$transaction(async (t) => {
          const channel = await t.channel.create({
            data: { name: `burst-${i}`, type: 'TEXT', position: i },
          });
          return t.channel.update({ where: { id: channel.id }, data: { position: i + 1 } });
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await db.channel.count()).toBe(300);
    await database.close();
  }, 60_000);
});
