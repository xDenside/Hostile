const DATABASE = 'hostile-bridge';
const STORE = 'certificates';
const THE_KEY = 'host';
const LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const MARGIN_MS = 24 * 60 * 60 * 1000;

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

export async function hostCertificate(): Promise<RTCCertificate> {
  const database = await openStore();
  try {
    const kept = (await asPromise(database.transaction(STORE).objectStore(STORE).get(THE_KEY))) as
      RTCCertificate | undefined;
    if (kept && kept.expires > Date.now() + MARGIN_MS) return kept;
    const made = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
      expires: LIFETIME_MS,
    } as AlgorithmIdentifier);
    await asPromise(database.transaction(STORE, 'readwrite').objectStore(STORE).put(made, THE_KEY));
    return made;
  } finally {
    database.close();
  }
}
