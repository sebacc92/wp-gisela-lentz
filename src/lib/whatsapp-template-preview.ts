import {
  containsRestrictedAutomationRequest,
  restrictedAutomationTerm,
} from "./automation-policy.ts";

/**
 * Vista previa de una plantilla de WhatsApp.
 *
 * Meta numera los parámetros como `{{1}}`, `{{2}}`… La previsualización los
 * reemplaza por datos de ejemplo para ver cómo le llega el mensaje al
 * paciente, sin tocar la plantilla guardada ni enviar nada.
 */

const PARAMETER_PATTERN = /\{\{(\d+)\}\}/g;

/** Números de parámetro usados, ordenados y sin repetir. */
export function templateParameters(body: string): number[] {
  const found = new Set<number>();
  for (const match of body.matchAll(PARAMETER_PATTERN)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) found.add(index);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Ejemplos por defecto. Son datos inventados y se ven como tales: nunca se
 * toman de un paciente real, porque una vista previa no es motivo para pasear
 * datos de alguien por la pantalla.
 */
export const SAMPLE_VALUES: readonly string[] = [
  "Ana",
  "viernes 11 de septiembre",
  "10:30",
  "$10.000",
  "Gisela Lentz",
];

export function sampleFor(index: number): string {
  return SAMPLE_VALUES[(index - 1) % SAMPLE_VALUES.length] ?? `dato ${index}`;
}

export function renderTemplatePreview(
  body: string,
  values: Record<number, string> = {},
): string {
  return body.replace(PARAMETER_PATTERN, (placeholder, raw: string) => {
    const index = Number(raw);
    if (!Number.isInteger(index) || index <= 0) return placeholder;
    const provided = values[index]?.trim();
    return provided || sampleFor(index);
  });
}

export type TemplateIssueLevel = "blocker" | "warning";

export interface TemplateIssue {
  level: TemplateIssueLevel;
  message: string;
}

/**
 * Revisión de contenido antes de mandar una plantilla a aprobar.
 *
 * No reemplaza la revisión de Meta: adelanta los rechazos más frecuentes y los
 * pedidos de datos que no pueden viajar por WhatsApp. Marca, no bloquea.
 */
export function reviewTemplateContent(body: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const trimmed = body.trim();

  if (!trimmed) {
    issues.push({ level: "blocker", message: "La plantilla está vacía." });
    return issues;
  }

  if (containsRestrictedAutomationRequest(trimmed)) {
    const term = restrictedAutomationTerm(trimmed);
    issues.push({
      level: "blocker",
      message: `Pide datos personales, bancarios o clínicos${
        term ? ` («${term}»)` : ""
      }. WhatsApp no es el canal para eso.`,
    });
  }

  // Meta rechaza los saltos numerados discontinuos: {{1}} y {{3}} sin {{2}}.
  const parameters = templateParameters(trimmed);
  const expected = parameters.map((_, index) => index + 1);
  if (parameters.length > 0 && parameters.join() !== expected.join()) {
    issues.push({
      level: "blocker",
      message: `Los parámetros tienen que ser correlativos desde {{1}}. Ahora usa: ${parameters
        .map((value) => `{{${value}}}`)
        .join(", ")}.`,
    });
  }

  if (/\{\{\s*[a-z_]+\s*\}\}/i.test(trimmed)) {
    issues.push({
      level: "blocker",
      message:
        "Meta numera los parámetros: usá {{1}}, {{2}}… en vez de nombres.",
    });
  }

  if (trimmed.length > 1024) {
    issues.push({
      level: "blocker",
      message: "El cuerpo supera los 1024 caracteres que acepta Meta.",
    });
  }

  if (/^\s*\{\{\d+\}\}/.test(trimmed) || /\{\{\d+\}\}\s*$/.test(trimmed)) {
    issues.push({
      level: "warning",
      message:
        "Meta suele rechazar plantillas que empiezan o terminan con un parámetro.",
    });
  }

  if (/(https?:\/\/|www\.)/i.test(trimmed)) {
    issues.push({
      level: "warning",
      message:
        "Los enlaces exigen más revisión de Meta y pueden demorar la aprobación.",
    });
  }

  return issues;
}
