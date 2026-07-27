import type { WrappedKey } from "../platform/api.ts";

const RP_NAME = "oiia";

function toB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rand(n: number): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(a);
  return a;
}

function u8(src: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
  const view = src instanceof Uint8Array ? src : new Uint8Array(src);
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials?.create;
}

export interface EnrolledPasskey {
  credentialId: string;
  transports: string[];
}

export async function enrollPasskey(userLabel: string): Promise<EnrolledPasskey> {
  if (!passkeysSupported()) throw new Error("passkeys-unsupported");
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: window.location.hostname, name: RP_NAME },
      user: { id: rand(16), name: userLabel.slice(0, 64) || "oiia", displayName: userLabel.slice(0, 64) || "oiia" },
      challenge: rand(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
      timeout: 120_000,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey-cancelled");
  const transports =
    typeof (cred.response as AuthenticatorAttestationResponse).getTransports === "function"
      ? (cred.response as AuthenticatorAttestationResponse).getTransports()
      : [];
  return { credentialId: toB64url(cred.rawId), transports };
}

async function prfSecret(credentialId: string, transports: string[], salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (!passkeysSupported()) throw new Error("passkeys-unsupported");
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      rpId: window.location.hostname,
      allowCredentials: [
        { type: "public-key", id: fromB64url(credentialId), transports: transports as AuthenticatorTransport[] },
      ],
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("passkey-cancelled");
  const ext = assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const secret = ext.prf?.results?.first;
  if (!secret) throw new Error("prf-unsupported");
  return u8(secret);
}

async function aesKeyFromSecret(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function wrapPrivateKey(credentialId: string, transports: string[], privateKey: string): Promise<WrappedKey> {
  const salt = rand(32);
  const iv = rand(12);
  const key = await aesKeyFromSecret(await prfSecret(credentialId, transports, salt));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, u8(new TextEncoder().encode(privateKey)));
  return { v: 1, credentialId, salt: toB64url(salt), iv: toB64url(iv), ct: toB64url(ct) };
}

export async function unwrapPrivateKey(blob: WrappedKey, transports: string[]): Promise<string> {
  const secret = await prfSecret(blob.credentialId, transports, fromB64url(blob.salt));
  const key = await aesKeyFromSecret(secret);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(blob.iv) }, key, fromB64url(blob.ct));
  return new TextDecoder().decode(pt);
}

export function passkeyErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "passkeys-unsupported") return "This browser doesn't support passkeys.";
  if (msg === "prf-unsupported") return "This passkey/browser doesn't support the PRF extension needed to protect keys.";
  if (msg === "passkey-cancelled" || /NotAllowedError|aborted|cancel/i.test(msg)) return "Passkey prompt was cancelled.";
  return msg;
}
