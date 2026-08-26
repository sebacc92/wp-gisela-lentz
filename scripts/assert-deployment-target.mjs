import { existsSync, readFileSync } from "node:fs";

const forbiddenProjectRef = "bbyyekxmabgjrtayyjgz";
const forbiddenVercelProject = "colp-whatsapp-ia";
const failures = [];

for (const file of [
  "supabase/.temp/project-ref",
  "supabase/.temp/linked-project.json",
]) {
  if (!existsSync(file)) continue;
  const value = readFileSync(file, "utf8");
  if (value.includes(forbiddenProjectRef)) failures.push(file);
}

const vercelFile = ".vercel/project.json";
if (existsSync(vercelFile)) {
  const value = readFileSync(vercelFile, "utf8");
  if (value.includes(forbiddenVercelProject)) failures.push(vercelFile);
}

if (failures.length) {
  console.error(
    `Despliegue bloqueado: todavía hay enlaces locales al proyecto anterior (${failures.join(", ")}). Vinculá primero los proyectos nuevos de Gisela.`,
  );
  process.exit(1);
}
