import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  TreatmentItemStatus,
  TreatmentPlanItem,
} from "~/lib/treatment-plan";

/**
 * Plan de tratamiento de un paciente.
 *
 * Es presupuesto, no historia clínica: por eso acepta modificación y borrado,
 * a diferencia de `odontogram_entries`. Sólo ADMIN, igual que el resto de la
 * ficha clínica.
 */

export async function loadTreatmentPlan(
  client: SupabaseClient,
  contactId: string,
): Promise<TreatmentPlanItem[]> {
  const { data, error } = await client
    .from("treatment_plan_items")
    .select(
      "id,tooth,description,estimated_cost_ars,status,note,completed_at,created_at",
    )
    .eq("contact_id", contactId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;

  return (data ?? []).map((raw) => {
    const row = raw as unknown as {
      id: string;
      tooth: number | null;
      description: string;
      estimated_cost_ars: number | null;
      status: TreatmentItemStatus;
      note: string | null;
      completed_at: string | null;
      created_at: string;
    };
    return {
      id: row.id,
      tooth: row.tooth,
      description: row.description,
      estimatedCostArs: row.estimated_cost_ars,
      status: row.status,
      note: row.note,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  });
}

export async function createTreatmentItem(
  client: SupabaseClient,
  input: {
    contactId: string;
    tooth: number | null;
    description: string;
    estimatedCostArs: number | null;
  },
): Promise<void> {
  const { data: userData } = await client.auth.getUser();
  const createdBy = userData.user?.id;
  // La política exige que quien lo carga quede registrado.
  if (!createdBy) throw new Error("UNAUTHORIZED");

  const { error } = await client.from("treatment_plan_items").insert({
    contact_id: input.contactId,
    tooth: input.tooth,
    description: input.description.trim().slice(0, 300),
    estimated_cost_ars: input.estimatedCostArs,
    created_by: createdBy,
  });
  if (error) throw error;
}

export async function updateTreatmentItemStatus(
  client: SupabaseClient,
  itemId: string,
  status: TreatmentItemStatus,
): Promise<void> {
  // `completed_at` lo mantiene un trigger: la interfaz no lo calcula.
  const { error } = await client
    .from("treatment_plan_items")
    .update({ status })
    .eq("id", itemId);
  if (error) throw error;
}

export async function deleteTreatmentItem(
  client: SupabaseClient,
  itemId: string,
): Promise<void> {
  const { error } = await client
    .from("treatment_plan_items")
    .delete()
    .eq("id", itemId);
  if (error) throw error;
}
