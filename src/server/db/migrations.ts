import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  openDatabase,
  type DatabaseConnection,
} from "@/server/db/connection";

export const defaultMigrationsFolder = path.resolve(
  process.cwd(),
  "drizzle",
);

export function migrateDatabase(
  connection: DatabaseConnection,
  migrationsFolder = defaultMigrationsFolder,
) {
  migrate(connection.db, { migrationsFolder });
}

export function initializeDatabase(
  databasePath: string,
  migrationsFolder = defaultMigrationsFolder,
) {
  const connection = openDatabase(databasePath);
  try {
    // This is the only place that changes the database-wide journal mode.
    // Docker runs it under flock before starting either the web server or the
    // worker, so concurrent service startup cannot race this PRAGMA.
    connection.sqlite.pragma("journal_mode = WAL");
    migrateDatabase(connection, migrationsFolder);
    const assetColumns = connection.sqlite
      .prepare("PRAGMA table_info(assets)")
      .all() as Array<{ name: string }>;
    if (!assetColumns.some((column) => column.name === "source_batch_id")) {
      connection.sqlite.exec(
        "ALTER TABLE assets ADD COLUMN source_batch_id text REFERENCES video_scene_batches(id)",
      );
    }
    connection.sqlite.exec(
      "CREATE INDEX IF NOT EXISTS assets_source_batch_idx ON assets(source_batch_id)",
    );
    const sceneBatchColumns = connection.sqlite
      .prepare("PRAGMA table_info(video_scene_batches)")
      .all() as Array<{ name: string }>;
    if (!sceneBatchColumns.some((column) => column.name === "deleted_at")) {
      connection.sqlite.exec(
        "ALTER TABLE video_scene_batches ADD COLUMN deleted_at integer",
      );
    }
    return connection;
  } catch (error) {
    connection.sqlite.close();
    throw error;
  }
}
