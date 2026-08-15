const DEVELOPMENT_HOSTS = new Set([
  "a806-housingconnectapi.nyc.gov",
  "www.nychdc.com",
  "nychdc.com",
  "residenewyork.com",
  "www.residenewyork.com",
  "fifthave.org",
  "www.fifthave.org",
]);

const LOCAL_LISTING_IMAGE_PREFIX = "/listing-images/";

function allowedHttpsUrl(value: string | null | undefined, hosts: Set<string>) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && hosts.has(url.hostname);
  } catch {
    return false;
  }
}

export function isDevelopmentPhotoSource(
  value: string | null | undefined
): value is string {
  if (!allowedHttpsUrl(value, DEVELOPMENT_HOSTS)) return false;
  const url = new URL(value!);
  return url.hostname !== "a806-housingconnectapi.nyc.gov" ||
    url.pathname.startsWith("/MailTemplates/photos/");
}

export function isListingPhotoSource(value: string | null | undefined): value is string {
  if (value?.startsWith("/")) {
    try {
      const url = new URL(value, "https://super.local");
      return url.origin === "https://super.local" &&
        url.pathname.startsWith(LOCAL_LISTING_IMAGE_PREFIX);
    } catch {
      return false;
    }
  }
  return isDevelopmentPhotoSource(value);
}

export function isDisplayImageSource(value: string | null | undefined): value is string {
  return isListingPhotoSource(value) || allowedHttpsUrl(value, new Set(["cdn.shopify.com"]));
}
