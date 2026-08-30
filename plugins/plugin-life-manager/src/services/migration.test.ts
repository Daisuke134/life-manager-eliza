import { describe, expect, it } from "vitest";
import {
  LIFE_MANAGER_DOMAIN_TABLES,
  migrateLifeManagerDomain,
  type SqlExecutor,
} from "./migration.ts";

describe("LifeManagerMigration", () => {
  it("installs append-only receipt triggers once without mutating legacy sources", async () => {
    const statements: string[] = [];
    let marked = false;
    const exec: SqlExecutor = async (statement) => {
      statements.push(statement);
      if (/SELECT EXISTS[\s\S]*life_manager_migration_state/.test(statement)) {
        return [{ done: marked }];
      }
      if (/INSERT INTO[\s\S]*life_manager_migration_state/.test(statement)) {
        marked = true;
      }
      return [];
    };

    await expect(migrateLifeManagerDomain(exec)).resolves.toEqual({
      outcome: "installed",
      tables: [...LIFE_MANAGER_DOMAIN_TABLES],
    });
    await expect(migrateLifeManagerDomain(exec)).resolves.toEqual({
      outcome: "already-migrated",
      tables: [...LIFE_MANAGER_DOMAIN_TABLES],
    });

    const sql = statements.join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS[\s\S]*life_manager_migration_state/);
    expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(2);
    expect(sql).toMatch(/outcome_receipts[\s\S]*BEFORE UPDATE OR DELETE/);
    expect(sql).toMatch(/economic_receipts[\s\S]*BEFORE UPDATE OR DELETE/);
    expect(sql).toMatch(/INSERT INTO[\s\S]*life_manager_migration_state[\s\S]*ON CONFLICT/);
    expect(sql).not.toMatch(/(?:DROP|ALTER)\s+TABLE\s+(?:public\.)?lm_runtime_/i);
  });
});
