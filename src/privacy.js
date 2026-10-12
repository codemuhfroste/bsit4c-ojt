// Version of the Privacy Notice (public/privacy.html). Bump it when the notice changes in a way that needs fresh
// consent: everyone is then asked to accept it again before using the app.
export const PRIVACY_VERSION = "2026-10-12";

// Who people can contact about their data. PRIVACY_CONTACT wins; otherwise the address the app sends email from.
export function privacyContact() {
  const explicit = (process.env.PRIVACY_CONTACT || "").trim();
  if (explicit) return explicit;
  const from = process.env.MAIL_FROM || "";
  return from.match(/<([^>]+)>/)?.[1] ?? (from.includes("@") ? from.trim() : "");
}
