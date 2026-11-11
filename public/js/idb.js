// The videos, the voice and the music stay on this device, in IndexedDB, keyed by project.
// Nothing heavy is uploaded: the server only stores the project's structure.
let abierta = null;
function abrir() {
  return abierta || (abierta = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('estudio-daniela', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('f');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
}
async function tx(modo, fn) {
  try {
    const d = await abrir();
    return await new Promise((res, rej) => {
      const t = d.transaction('f', modo), q = fn(t.objectStore('f'));
      t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  } catch { return null; }
}
export const idb = {
  put: (k, v) => tx('readwrite', s => s.put(v, k)),
  get: k => tx('readonly', s => s.get(k)),
  del: k => tx('readwrite', s => s.delete(k)),
  // Keys of one project: "<pid>/..." — a bounded range keeps other projects out.
  claves: pid => tx('readonly', s => s.getAllKeys(IDBKeyRange.bound(pid + '/', pid + '/￿'))),
  async borrarProyecto(pid) { return tx('readwrite', s => s.delete(IDBKeyRange.bound(pid + '/', pid + '/￿'))); },
};
// Ask the browser not to evict the videos when the disk gets tight.
export function pedirPersistencia() { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {} }
