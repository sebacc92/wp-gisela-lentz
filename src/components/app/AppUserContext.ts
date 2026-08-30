import { createContextId } from "@qwik.dev/core";

export interface AppUserContextValue {
  fullName: string;
  isAdmin: boolean;
}

export const APP_USER_CONTEXT = createContextId<AppUserContextValue>(
  "gisela-lentz.app-user",
);
