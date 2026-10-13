export type Migration = { version: string; name: string; sql: string; checksum: string };
export type MigrateClient = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};
export const MIGRATIONS_DIR: string;
export function loadMigrations(dir?: string): Migration[];
export function migrate(
  client: MigrateClient,
  opts?: { migrations?: Migration[]; log?: (line: string) => void },
): Promise<{ applied: string[]; skipped: string[] }>;
