export function appAutomationsEnabled(settings: unknown): boolean {
  if (settings === null || typeof settings !== "object") return false;

  return (
    (settings as { automations_enabled?: unknown }).automations_enabled === true
  );
}
