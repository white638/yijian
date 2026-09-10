/// <reference types="vite/client" />
import type { AppState } from "./types";

export const onlineBuild = import.meta.env.VITE_EDITION === "online";
export const online = (state: AppState) =>
  state.edition === "online" || state.features.online === true;
export function feature(state: AppState, name: string): boolean {
  if (!online(state)) return true;
  return state.features.capabilities?.[name] === true;
}

export interface AccountUser {
  id: string;
  email: string;
  name: string;
}
export interface AccountConfig {
  registrationMode: "open" | "invite" | "closed";
  edition: string;
  features: Record<string, boolean>;
}
