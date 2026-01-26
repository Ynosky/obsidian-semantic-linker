type DBConfig = {
    readonly dbName: string;
    readonly storeName: string;
    readonly version: number;
    readonly keyPath: string;
};

type CursorAction<T> = (item: T) => boolean | undefined;

const promisify = <T>(request: IDBRequest<T> | IDBOpenDBRequest): Promise<T> =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result as T);

        request.onerror = () => {
            const error =
                request.error ?? new Error('IndexedDB request failed');
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        if ('onblocked' in request) {
            request.onblocked = () => {
                console.warn(
                    'IndexedDB blocked: Please close other tabs/windows.',
                );
            };
        }
    });

const txAsPromise = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
            const error = tx.error ?? new Error('Transaction failed');
            reject(error instanceof Error ? error : new Error(String(error)));
        };
    });

export type RawStorage = {
    readonly getAll: <T>() => Promise<readonly T[]>;
    readonly getByKey: <T>(key: string) => Promise<T | undefined>;
    readonly getKeys: () => Promise<readonly string[]>;
    readonly putBatch: <T>(items: readonly T[]) => Promise<void>;
    readonly clear: () => Promise<void>;
    readonly clearAndPutBatch: <T>(items: readonly T[]) => Promise<void>;
    readonly stream: <T>(action: CursorAction<T>) => Promise<void>;
    readonly deleteByKey: (key: string) => Promise<void>;
    readonly deleteBatch: (keys: readonly string[]) => Promise<void>;
};

export const createStorageProvider = (config: DBConfig): RawStorage => {
    const STORES_DEF: Record<string, string> = {
        status: 'id',
        vectors: 'path',
    };
    const open = async (): Promise<IDBDatabase> => {
        const request = indexedDB.open(config.dbName, config.version);

        request.onupgradeneeded = () => {
            const db = request.result;
            for (const [sName, kPath] of Object.entries(STORES_DEF)) {
                if (!db.objectStoreNames.contains(sName)) {
                    db.createObjectStore(sName, { keyPath: kPath });
                }
            }
        };

        return promisify<IDBDatabase>(request);
    };

    const withStore = async <T>(
        mode: IDBTransactionMode,
        operation: (
            store: IDBObjectStore,
        ) => IDBRequest<T> | Promise<void> | void,
    ): Promise<T> => {
        const db = await open();
        if (!db.objectStoreNames.contains(config.storeName)) {
            throw new Error(
                `Store "${config.storeName}" not found. Reload plugin.`,
            );
        }
        const tx = db.transaction(config.storeName, mode);
        const store = tx.objectStore(config.storeName);

        let resultValue: T | undefined;
        const opResult = operation(store);

        if (opResult instanceof IDBRequest) {
            resultValue = await promisify<T>(opResult);
        } else if (opResult instanceof Promise) {
            await opResult;
        }

        await txAsPromise(tx);
        return resultValue as T;
    };

    return {
        getAll: <T>() =>
            withStore<readonly T[]>(
                'readonly',
                (store) =>
                    store.getAll() as unknown as IDBRequest<readonly T[]>,
            ),

        getByKey: <T>(key: string) =>
            withStore<T | undefined>(
                'readonly',
                (store) =>
                    store.get(key) as unknown as IDBRequest<T | undefined>,
            ),

        getKeys: () =>
            withStore<readonly string[]>(
                'readonly',
                (store) =>
                    store.getAllKeys() as unknown as IDBRequest<
                        readonly string[]
                    >,
            ),

        putBatch: (items) =>
            withStore('readwrite', (store) => {
                for (const item of items) store.put(item);
            }),

        clear: () =>
            withStore('readwrite', (store) => {
                store.clear();
            }),

        clearAndPutBatch: (items) =>
            withStore('readwrite', (store) => {
                store.clear();
                for (const item of items) store.put(item);
            }),

        deleteByKey: (key) =>
            withStore('readwrite', (store) => {
                store.delete(key);
            }),

        deleteBatch: (keys) =>
            withStore('readwrite', (store) => {
                for (const key of keys) {
                    store.delete(key);
                }
            }),

        stream: async <T>(action: CursorAction<T>) => {
            const db = await open();
            const tx = db.transaction(config.storeName, 'readonly');
            const request = tx.objectStore(config.storeName).openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (action(cursor.value as T) !== false) cursor.continue();
            };
            return txAsPromise(tx);
        },
    };
};
