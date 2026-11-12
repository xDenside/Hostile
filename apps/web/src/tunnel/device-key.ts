const DB_NAME = 'hostile-device';
const STORE = 'keys';

export interface DeviceKey {
  publicKey: string;
  sign(text: string): Promise<string>;
}

let current: DeviceKey | null = null;

export const currentDeviceKey = () => current?.publicKey ?? null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
  });
}

async function database(): Promise<IDBDatabase> {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  return request(open);
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function stored(db: IDBDatabase, name: string): Promise<CryptoKeyPair | undefined> {
  return request(db.transaction(STORE).objectStore(STORE).get(name)) as Promise<
    CryptoKeyPair | undefined
  >;
}

export async function deviceKeyFor(name: string): Promise<DeviceKey> {
  const db = await database();
  try {
    let pair = await stored(db, name);
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
      ]);
      await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(pair, name));
    }
    const keys = pair;
    const publicKey = base64url(await crypto.subtle.exportKey('spki', keys.publicKey));
    current = {
      publicKey,
      sign: async (text) =>
        base64url(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keys.privateKey,
            new TextEncoder().encode(text),
          ),
        ),
    };
    return current;
  } finally {
    db.close();
  }
}

export async function forgetDeviceKey(name: string): Promise<void> {
  current = null;
  const db = await database();
  try {
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(name));
  } finally {
    db.close();
  }
}
