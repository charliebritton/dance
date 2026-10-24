// Passkey ceremonies. The server sends WebAuthn options as JSON; these turn them into browser calls and back.
// Uses the browser's own JSON helpers where they exist, with a base64url fallback for older browsers.

const b2u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const u2b = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials?.create);

function creationOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return { ...o, challenge: u2b(o.challenge), user: { ...o.user, id: u2b(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: u2b(c.id) })) };
}
function requestOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: u2b(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: u2b(c.id) })) };
}

function friendly(e) {
  if (e?.name === "NotAllowedError") return new Error("The passkey prompt was closed or timed out. Try again");
  if (e?.name === "InvalidStateError") return new Error("This device already has a passkey for your account");
  if (e?.name === "SecurityError") return new Error("Passkeys only work on the site's own address over HTTPS");
  return new Error(e?.message || "Your browser couldn't use a passkey");
}

export async function createPasskey(options) {
  let cred;
  try { cred = await navigator.credentials.create({ publicKey: creationOptions(options) }); } catch (e) { throw friendly(e); }
  if (cred.toJSON) return cred.toJSON();
  return { id: cred.id, rawId: b2u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response: { clientDataJSON: b2u(cred.response.clientDataJSON), attestationObject: b2u(cred.response.attestationObject),
      transports: cred.response.getTransports?.() || [] } };
}

export async function getPasskey(options) {
  let cred;
  try { cred = await navigator.credentials.get({ publicKey: requestOptions(options) }); } catch (e) { throw friendly(e); }
  if (cred.toJSON) return cred.toJSON();
  const r = cred.response;
  return { id: cred.id, rawId: b2u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response: { clientDataJSON: b2u(r.clientDataJSON), authenticatorData: b2u(r.authenticatorData), signature: b2u(r.signature),
      userHandle: r.userHandle ? b2u(r.userHandle) : null } };
}

/** A label for the passkey list, e.g. "iPhone" or "Chrome on Linux". */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "This device";
  const br = /Firefox/.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  return br && !["iPhone", "iPad"].includes(os) ? `${br} on ${os}` : os;
}
