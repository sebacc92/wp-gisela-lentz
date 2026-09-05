import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260905183000_google_calendar_disconnect_safe_update.sql",
  ),
  "utf8",
);

test("la desconexión acota la limpieza de jobs para sesiones con safeupdate", () => {
  const cleanupStart = migration.indexOf(
    "update public.google_calendar_sync_jobs job",
    migration.indexOf("update public.google_calendar_connections"),
  );
  const cleanupEnd = migration.indexOf(";", cleanupStart);

  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);

  const cleanup = migration.slice(cleanupStart, cleanupEnd);

  assert.match(cleanup, /google_event_id = null/);
  assert.match(cleanup, /projected_ends_at = null\s+where\s+/);
  assert.match(cleanup, /job\.status in \('pending', 'processing', 'failed'\)/);
  assert.match(cleanup, /job\.processing_started_at is not null/);
  assert.match(cleanup, /job\.google_event_id is not null/);
  assert.match(cleanup, /job\.google_etag is not null/);
  assert.match(cleanup, /job\.projected_operation is not null/);
  assert.match(cleanup, /job\.projected_starts_at is not null/);
  assert.match(cleanup, /job\.projected_ends_at is not null/);
  assert.doesNotMatch(cleanup, /where\s+(?:true|1\s*=\s*1)\b/);
});
