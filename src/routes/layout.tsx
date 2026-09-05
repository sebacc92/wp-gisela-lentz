import { component$, Slot } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { getCanonicalUrl } from "~/config/site";

export default component$(() => <Slot />);

export const head: DocumentHead = ({ url }) => ({
  links: [
    {
      key: "canonical",
      rel: "canonical",
      href: getCanonicalUrl(url.pathname),
    },
  ],
});
