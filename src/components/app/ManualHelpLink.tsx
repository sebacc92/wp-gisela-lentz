import { component$, useSignal, useVisibleTask$ } from "@qwik.dev/core";
import { Link } from "@qwik.dev/router";
import { isAdminProfile } from "~/lib/admin-access";
import { manualSectionHref, type ManualSectionId } from "~/lib/manual-status";
import { getSupabaseClient } from "~/lib/supabase/client";
import { Icon } from "../ui/Icon";

interface ManualHelpLinkProps {
  section: ManualSectionId;
  label: string;
}

/**
 * Contextual help is deliberately hidden until the active profile is confirmed
 * as ADMIN. The Manual route repeats this guard for direct navigation.
 */
export const ManualHelpLink = component$<ManualHelpLinkProps>(
  ({ section, label }) => {
    const isAdmin = useSignal(false);

    // eslint-disable-next-line qwik/no-use-visible-task
    useVisibleTask$(async () => {
      try {
        const client = getSupabaseClient();
        const {
          data: { user },
        } = await client.auth.getUser();
        if (!user) return;
        const { data: profile } = await client
          .from("profiles")
          .select("role,active")
          .eq("id", user.id)
          .maybeSingle();
        isAdmin.value = isAdminProfile(profile);
      } catch {
        isAdmin.value = false;
      }
    });

    if (!isAdmin.value) return null;

    return (
      <Link class="manual-context-link" href={manualSectionHref(section)}>
        <Icon name="info" size={16} /> {label}
      </Link>
    );
  },
);
