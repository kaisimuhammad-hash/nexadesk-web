import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';

export async function useFirestoreAuthState(db, accountId) {
  const rootDoc = db.collection('nexadesk_sessions').doc(accountId);

  const fixId = (id) => String(id).replace(/\//g, '__');

  const writeData = async (data, category, id) => {
    const docId = fixId(id);
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await rootDoc.collection(category).doc(docId).set({
      data: serialized,
      updatedAt: Date.now(),
    });
  };

  const readData = async (category, id) => {
    try {
      const docId = fixId(id);
      const doc = await rootDoc.collection(category).doc(docId).get();
      if (!doc.exists) return null;
      return JSON.parse(doc.data().data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (category, id) => {
    try {
      const docId = fixId(id);
      await rootDoc.collection(category).doc(docId).delete();
    } catch {
      /* ignore */
    }
  };

  const creds = (await readData('auth', 'creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData(type, id);
              if (value) {
                data[id] = value;
              }
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) {
                tasks.push(writeData(value, category, id));
              } else {
                tasks.push(removeData(category, id));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'auth', 'creds'),
    clearState: async () => {
      const categories = [
        'auth',
        'pre-key',
        'session',
        'sender-key',
        'app-state-sync-key',
        'app-state-sync-version',
        'sender-key-memory',
      ];
      for (const cat of categories) {
        const snap = await rootDoc.collection(cat).get();
        if (!snap.empty) {
          const batch = db.batch();
          snap.docs.forEach((doc) => batch.delete(doc.ref));
          await batch.commit();
        }
      }
    },
    hasCreds: async () => {
      const doc = await rootDoc.collection('auth').doc('creds').get();
      return doc.exists;
    },
  };
}
