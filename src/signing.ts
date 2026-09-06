/**
 * Optional, opt-in event signing (Ed25519 via Web Crypto — available in Workers, Node 19+, and
 * browsers). Not wired into executeCommand automatically: sign what you choose to sign, verify
 * it wherever you read events back out, store the Signature alongside the event however your
 * adapter/projection does that. Kept deliberately simpler than PEM import/export — callers manage
 * their own CryptoKey storage (a KMS, a secrets store, whatever fits), this module just does the
 * sign/verify math.
 */

export interface Signature {
  readonly algorithm: 'Ed25519';
  readonly publicKeyId: string;
  readonly signatureHex: string;
  readonly signedAt: number;
}

export interface EventSigner {
  sign(payload: unknown): Promise<Signature>;
  verify(payload: unknown, signature: Signature): Promise<boolean>;
}

export interface SigningKeyPair {
  readonly id: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

export async function generateSigningKeyPair(id: string): Promise<SigningKeyPair> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return { id, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
}

export function createEd25519Signer(keys: SigningKeyPair): EventSigner {
  return {
    async sign(payload: unknown): Promise<Signature> {
      const message = canonicalBytes(payload);
      const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, toArrayBuffer(message));
      return {
        algorithm: 'Ed25519',
        publicKeyId: keys.id,
        signatureHex: bufferToHex(new Uint8Array(signature)),
        signedAt: Date.now(),
      };
    },

    async verify(payload: unknown, signature: Signature): Promise<boolean> {
      if (signature.publicKeyId !== keys.id) return false;
      try {
        const message = canonicalBytes(payload);
        const sig = hexToBuffer(signature.signatureHex);
        return await crypto.subtle.verify('Ed25519', keys.publicKey, toArrayBuffer(sig), toArrayBuffer(message));
      } catch {
        return false;
      }
    },
  };
}

function canonicalBytes(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
