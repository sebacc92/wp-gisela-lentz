import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Una nota interna es para el equipo, nunca para el paciente.
 *
 * Lo que garantiza eso no es la interfaz: es que ninguna Function —y en
 * particular ninguna que envíe— sepa que `conversation_notes` existe. Si
 * mañana alguien la consulta desde el backend de WhatsApp, este contrato falla
 * antes de que una nota pueda terminar en un chat.
 */
test("ninguna Function conoce las notas internas", () => {
  const root = resolve(process.cwd(), "supabase/functions");
  const offenders = walk(root)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => readFileSync(file, "utf8").includes("conversation_notes"))
    .map((file) => file.slice(root.length + 1));

  assert.deepEqual(
    offenders,
    [],
    `estas Functions nombran conversation_notes: ${offenders.join(", ")}`,
  );
});

/**
 * El envío de WhatsApp toma el texto de `messages`. Las notas viven aparte
 * justamente para que no exista un camino que las confunda con un mensaje.
 */
test("las notas no comparten tabla con los mensajes enviables", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/20260910120000_conversation_notes.sql",
    ),
    "utf8",
  );

  assert.match(migration, /create table public\.conversation_notes/);
  assert.match(migration, /enable row level security/);
  // `anon` no puede leerlas bajo ninguna circunstancia.
  assert.match(migration, /revoke all on public\.conversation_notes from anon/);
  // Quien escribe queda registrado: una nota anónima no sirve para coordinarse.
  assert.match(migration, /author_id = auth\.uid\(\)/);
});
