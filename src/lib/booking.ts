import type { DepositStatus, PatientCoverage } from "./inbox-types";

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

export type AppointmentDisplayStatus =
  | "Esperando seña"
  | "Comprobante recibido"
  | "Confirmado"
  | "Atendido"
  | "Cancelado"
  | "No asistió";

export const coverageLabels: Record<PatientCoverage, string> = {
  ioma: "IOMA",
  particular: "Particular",
};

export function coverageLabel(coverage?: PatientCoverage | null): string {
  return coverage ? coverageLabels[coverage] : "Cobertura pendiente";
}

export function coverageAndDuration(
  coverage?: PatientCoverage | null,
  durationMinutes?: number | null,
): string {
  const coverageCopy = coverageLabel(coverage);
  return durationMinutes
    ? `${coverageCopy} · ${durationMinutes} min`
    : coverageCopy;
}

export function appointmentDisplayStatus(
  status: AppointmentStatus,
  depositStatus?: DepositStatus | null,
): AppointmentDisplayStatus {
  if (status === "cancelled") return "Cancelado";
  if (status === "completed") return "Atendido";
  if (status === "no_show") return "No asistió";
  if (depositStatus === "expired") return "Cancelado";
  if (
    status === "confirmed" ||
    depositStatus === "confirmed" ||
    depositStatus === "not_required"
  ) {
    return "Confirmado";
  }
  if (depositStatus === "proof_received") return "Comprobante recibido";
  return "Esperando seña";
}

export function appointmentStatusTone(
  status: AppointmentStatus,
  depositStatus?: DepositStatus | null,
): string {
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "completed";
  if (status === "no_show") return "no_show";
  if (depositStatus === "expired") return "cancelled";
  if (
    status === "confirmed" ||
    depositStatus === "confirmed" ||
    depositStatus === "not_required"
  ) {
    return "confirmed";
  }
  return depositStatus === "proof_received" ? "proof-received" : "scheduled";
}

export function effectiveDepositStatus(
  status: AppointmentStatus,
  depositStatus: DepositStatus,
  holdExpiresAt?: string | null,
  now = Date.now(),
): DepositStatus {
  if (
    status === "scheduled" &&
    depositStatus === "pending" &&
    holdExpiresAt &&
    new Date(holdExpiresAt).getTime() <= now
  ) {
    return "expired";
  }
  return depositStatus;
}
