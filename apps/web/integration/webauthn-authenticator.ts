import { createHash } from 'node:crypto';

/**
 * A software WebAuthn authenticator for integration tests: it performs the
 * same cryptographic ceremony a real platform/roaming authenticator or the
 * browser's `navigator.credentials` would (an ES256 keypair, CBOR-encoded
 * attestation/authenticator data, a DER-encoded assertion signature), so the
 * real `@simplewebauthn/server` verification inside the passkey plugin runs
 * unmodified. Only the human presenting a physical device is out of scope
 * here; that is covered by the Playwright CDP virtual-authenticator suite.
 */

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

// --- Minimal CBOR encoder: just enough for a "none" attestation object and
// a COSE_Key EC2/ES256 map. Not a general-purpose encoder. ---

function cborUint(value: number): number[] {
  if (value < 24) return [value];
  if (value < 256) return [0x18, value];
  return [0x19, (value >> 8) & 0xff, value & 0xff];
}

function cborTextString(value: string): number[] {
  const bytes = Array.from(utf8(value));
  return [
    ...cborUint(bytes.length).map((b, i) => (i === 0 ? b | 0x60 : b)),
    ...bytes,
  ];
}

function cborByteString(bytes: Uint8Array): number[] {
  const header = cborUint(bytes.length);
  header[0] = (header[0] ?? 0) | 0x40;
  return [...header, ...bytes];
}

/** COSE_Key for an EC2 P-256 (ES256) public key: {1:2, 3:-7, -1:1, -2:x, -3:y}. */
function coseEc2Key(x: Uint8Array, y: Uint8Array): Uint8Array {
  const out: number[] = [];
  out.push(0xa5); // map of 5 pairs
  // 1: 2  (kty: EC2)
  out.push(0x01, 0x02);
  // 3: -7 (alg: ES256) -- negative int -7 => encode as 0x26 (major 1, value 6)
  out.push(0x03, 0x26);
  // -1: 1 (crv: P-256) -- key -1 => 0x20, value 1
  out.push(0x20, 0x01);
  // -2: bytes x -- key -2 => 0x21
  out.push(0x21, ...cborByteString(x));
  // -3: bytes y -- key -3 => 0x22
  out.push(0x22, ...cborByteString(y));
  return new Uint8Array(out);
}

function encodeAttestationObject(authData: Uint8Array): Uint8Array {
  const out: number[] = [];
  out.push(0xa3); // map of 3 pairs
  out.push(...cborTextString('fmt'));
  out.push(...cborTextString('none'));
  out.push(...cborTextString('attStmt'));
  out.push(0xa0); // empty map
  out.push(...cborTextString('authData'));
  out.push(...cborByteString(authData));
  return new Uint8Array(out);
}

function buildAuthData(input: {
  rpID: string;
  signCount: number;
  attestedCredentialData?: {
    aaguid: Uint8Array;
    credentialId: Uint8Array;
    publicKey: Uint8Array;
  };
}): Uint8Array {
  const rpIdHash = sha256(utf8(input.rpID));
  const attested = input.attestedCredentialData !== undefined;
  const flags = 0x01 | (attested ? 0x40 : 0); // UP, AT if registering
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, input.signCount, false);
  const parts: Uint8Array[] = [rpIdHash, Uint8Array.of(flags), counter];
  if (input.attestedCredentialData) {
    const { aaguid, credentialId, publicKey } = input.attestedCredentialData;
    const idLength = new Uint8Array(2);
    new DataView(idLength.buffer).setUint16(0, credentialId.length, false);
    parts.push(aaguid, idLength, credentialId, publicKey);
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

/** Converts a WebCrypto raw (r||s) ECDSA signature to DER, as WebAuthn requires. */
function derFromRawSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const toInt = (part: Uint8Array): number[] => {
    let bytes = Array.from(part);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
    if ((bytes[0] ?? 0) & 0x80) bytes = [0, ...bytes];
    return bytes;
  };
  const r = toInt(raw.slice(0, half));
  const s = toInt(raw.slice(half));
  const seqBody = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return new Uint8Array([0x30, seqBody.length, ...seqBody]);
}

export type SoftwareCredential = {
  readonly id: string;
  readonly rawId: Uint8Array;
  readonly privateKey: CryptoKey;
  readonly publicKeyX: Uint8Array;
  readonly publicKeyY: Uint8Array;
  counter: number;
};

export async function createSoftwareCredential(): Promise<SoftwareCredential> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey),
  );
  // raw = 0x04 || X(32) || Y(32)
  const rawId = crypto.getRandomValues(new Uint8Array(32));
  return {
    id: b64url(rawId),
    rawId,
    privateKey: keyPair.privateKey,
    publicKeyX: raw.slice(1, 33),
    publicKeyY: raw.slice(33, 65),
    counter: 0,
  };
}

const clientDataJSON = (type: string, challenge: string, origin: string) =>
  utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

/** A RegistrationResponseJSON as a real authenticator/browser would produce. */
export function buildRegistrationResponse(input: {
  readonly credential: SoftwareCredential;
  readonly challenge: string;
  readonly origin: string;
  readonly rpID: string;
}) {
  const clientData = clientDataJSON(
    'webauthn.create',
    input.challenge,
    input.origin,
  );
  const publicKey = coseEc2Key(
    input.credential.publicKeyX,
    input.credential.publicKeyY,
  );
  const authData = buildAuthData({
    rpID: input.rpID,
    signCount: 0,
    attestedCredentialData: {
      aaguid: new Uint8Array(16),
      credentialId: input.credential.rawId,
      publicKey,
    },
  });
  return {
    id: input.credential.id,
    rawId: b64url(input.credential.rawId),
    response: {
      clientDataJSON: b64url(clientData),
      attestationObject: b64url(encodeAttestationObject(authData)),
      transports: ['internal'],
    },
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    type: 'public-key',
  };
}

/** An AuthenticationResponseJSON: a real assertion signed by the credential. */
export async function buildAuthenticationResponse(input: {
  readonly credential: SoftwareCredential;
  readonly challenge: string;
  readonly origin: string;
  readonly rpID: string;
}) {
  const clientData = clientDataJSON(
    'webauthn.get',
    input.challenge,
    input.origin,
  );
  input.credential.counter += 1;
  const authData = buildAuthData({
    rpID: input.rpID,
    signCount: input.credential.counter,
  });
  const toSign = Buffer.concat([
    Buffer.from(authData),
    Buffer.from(sha256(clientData)),
  ]);
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      input.credential.privateKey,
      toSign,
    ),
  );
  return {
    id: input.credential.id,
    rawId: b64url(input.credential.rawId),
    response: {
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(derFromRawSignature(rawSignature)),
    },
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    type: 'public-key',
  };
}
