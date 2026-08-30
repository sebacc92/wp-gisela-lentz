import { component$, useContext } from "@qwik.dev/core";
import { Link } from "@qwik.dev/router";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { manualSectionHref, type ManualSectionId } from "~/lib/manual-status";
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
    const appUser = useContext(APP_USER_CONTEXT);

    if (!appUser.isAdmin) return null;

    return (
      <Link class="manual-context-link" href={manualSectionHref(section)}>
        <Icon name="info" size={16} /> {label}
      </Link>
    );
  },
);
