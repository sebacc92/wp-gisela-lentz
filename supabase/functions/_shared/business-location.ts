export interface BusinessLocationSettings {
  business_address?: unknown;
  business_location_name?: unknown;
  business_location_address?: unknown;
  business_latitude?: unknown;
  business_longitude?: unknown;
  business_maps_url?: unknown;
}

export interface ResolvedBusinessLocation {
  latitude: number;
  longitude: number;
  name: string;
  address: string;
  displayAddress: string;
  mapsUrl: string;
}

export interface InformationFlowSessionTarget<Context> {
  state: string;
  context?: Context;
  expiresMinutes?: number;
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/g, " ");
  return clean && clean.length <= maximum ? clean : null;
}

export function stableGoogleMapsUrl(value: unknown): string | null {
  const clean = cleanText(value, 2_048);
  if (!clean) return null;
  try {
    const url = new URL(clean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.google.com" ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== "/maps/search/" ||
      url.searchParams.get("api") !== "1" ||
      !url.searchParams.get("query") ||
      !url.searchParams.get("query_place_id")
    ) {
      return null;
    }
    return clean;
  } catch {
    return null;
  }
}

/**
 * Resolves only a complete, explicitly configured business pin. It never
 * geocodes an address or guesses coordinates while handling a conversation.
 */
export function resolveBusinessLocation(
  settings: BusinessLocationSettings,
): ResolvedBusinessLocation | null {
  const name = cleanText(settings.business_location_name, 120);
  const address = cleanText(settings.business_location_address, 500);
  const displayAddress = cleanText(settings.business_address, 500);
  const mapsUrl = stableGoogleMapsUrl(settings.business_maps_url);
  const latitude = settings.business_latitude;
  const longitude = settings.business_longitude;
  if (
    !name ||
    !address ||
    !displayAddress ||
    !mapsUrl ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude, name, address, displayAddress, mapsUrl };
}

export function informationFlowSessionTarget<Context>(args: {
  resumeCurrentFlow: boolean;
  state: string;
  context: Context;
  expiresAt: string | null;
  now: Date;
}): InformationFlowSessionTarget<Context> {
  if (!args.resumeCurrentFlow) return { state: "idle" };
  const rawMinutes = args.expiresAt
    ? Math.max(
        1,
        Math.ceil(
          (new Date(args.expiresAt).getTime() - args.now.getTime()) / 60_000,
        ),
      )
    : 30;
  return {
    state: args.state,
    context: args.context,
    expiresMinutes: Number.isFinite(rawMinutes) ? rawMinutes : 30,
  };
}
