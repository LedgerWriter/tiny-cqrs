import { describe, expect, it } from 'vitest';
import { createEd25519Signer, generateSigningKeyPair } from '../src/signing.js';

describe('signing', () => {
  it('verifies a signature made with the matching key', async () => {
    const keys = await generateSigningKeyPair('key-1');
    const signer = createEd25519Signer(keys);
    const payload = { type: 'JournalEntryPosted', amount: 500 };

    const signature = await signer.sign(payload);
    expect(await signer.verify(payload, signature)).toBe(true);
  });

  it('rejects a signature after the payload is tampered with', async () => {
    const keys = await generateSigningKeyPair('key-1');
    const signer = createEd25519Signer(keys);
    const signature = await signer.sign({ amount: 500 });

    expect(await signer.verify({ amount: 501 }, signature)).toBe(false);
  });

  it('rejects a signature from a different key pair', async () => {
    const keysA = await generateSigningKeyPair('key-a');
    const keysB = await generateSigningKeyPair('key-b');
    const payload = { amount: 500 };

    const signature = await createEd25519Signer(keysA).sign(payload);
    expect(await createEd25519Signer(keysB).verify(payload, signature)).toBe(false);
  });
});
