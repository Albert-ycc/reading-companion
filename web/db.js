// IndexedDB：存书库文件夹的访问句柄、最近在读的书、各书库的 PDF 清单。
// 句柄只能存在浏览器里，服务端拿不到；这样 Chrome 记住授权，下次点开就能读。
let dbp;
function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("banDu", 1);
    req.onupgradeneeded = () => {
      for (const s of ["roots", "books", "index"]) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const idb = {
  get: (store, key) => run(store, "readonly", (s) => s.get(key)),
  put: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key)),
  del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
  all: (store) => run(store, "readonly", (s) => s.getAll()),
};
