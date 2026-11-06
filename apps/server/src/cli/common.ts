import { loadLocalEnv } from '../env.js';
import { loadConfig, type AppConfig } from '../config.js';
import { openDatabase, type Db } from '../db.js';

export async function cliContext(): Promise<{
  config: AppConfig;
  db: Db;
  close: () => Promise<void>;
}> {
  loadLocalEnv();
  const config = loadConfig();
  const { db, close } = await openDatabase(config.dataDir);
  return { config, db, close };
}
