import { createStorageProvider } from 'logic/storage';
import type { TFile } from 'obsidian';
import { DB_VERSION } from '../constants';
import { logger } from '../shared/notify';
import type { EmbeddedChunk, EmbeddedNote, VectorStore } from '../types';

export const StoreOps = {
    upsert: (
        store: VectorStore,
        file: TFile,
        chunks: readonly EmbeddedChunk[],
    ): VectorStore => ({
        ...store,
        entries: {
            ...store.entries,
            [file.path]: {
                path: file.path,
                mtime: file.stat.mtime,
                chunks,
            },
        },
    }),

    remove: (store: VectorStore, path: string): VectorStore => {
        const { [path]: _, ...rest } = store.entries;
        return { ...store, entries: rest };
    },

    isStale: (store: VectorStore, file: TFile): boolean => {
        const entry = store.entries[file.path];
        return !entry || entry.mtime !== file.stat.mtime || !entry.chunks;
    },
} as const;

export type VectorStoreService = {
    readonly getState: () => VectorStore;
    readonly load: () => Promise<void>;
    readonly commitUpsert: (
        file: TFile,
        chunks: readonly EmbeddedChunk[],
    ) => Promise<void>;
    readonly commitUpsertBatch: (
        items: { file: TFile; chunks: readonly EmbeddedChunk[] }[],
    ) => Promise<void>;
    readonly commitRemove: (path: string) => Promise<void>;
    readonly commitRemoveBatch: (paths: string[]) => Promise<void>;
    readonly clear: () => Promise<void>;
};

export const createVectorStoreService = (
    dbName: string,
): VectorStoreService => {
    const provider = createStorageProvider({
        dbName: dbName,
        storeName: 'vectors',
        version: DB_VERSION,
        keyPath: 'path',
    });

    let _current: VectorStore = { entries: {} };

    const load = async () => {
        try {
            const results = await provider.getAll<EmbeddedNote>();
            _current = {
                entries: Object.fromEntries(results.map((e) => [e.path, e])),
            };
        } catch (err) {
            logger.errorLog('Failed to load VectorStore:', err);
            _current = { entries: {} };
        }
    };

    const commitUpsert = async (
        file: TFile,
        chunks: readonly EmbeddedChunk[],
    ) => {
        console.debug('Committing upsert for', file.path);
        _current = StoreOps.upsert(_current, file, chunks);

        const entry: EmbeddedNote = {
            path: file.path,
            mtime: file.stat.mtime,
            chunks: [...chunks],
        };

        try {
            await provider.putBatch<EmbeddedNote>([entry]);
        } catch (err) {
            logger.errorLog(`Failed to save vector for ${file.path}:`, err);
        }
    };

    const commitUpsertBatch = async (
        items: { file: TFile; chunks: readonly EmbeddedChunk[] }[],
    ) => {
        console.debug('Committing batch upsert for', items.length, 'items');
        if (items.length === 0) return;

        items.forEach(({ file, chunks }) => {
            _current = StoreOps.upsert(_current, file, chunks);
        });

        const dbEntries: EmbeddedNote[] = items.map(({ file, chunks }) => ({
            path: file.path,
            mtime: file.stat.mtime,
            chunks: [...chunks],
        }));

        try {
            await provider.putBatch<EmbeddedNote>(dbEntries);
        } catch (err) {
            logger.errorLog('Batch update failed:', err);
        }
    };

    const commitRemove = async (path: string) => {
        _current = StoreOps.remove(_current, path);
        try {
            await provider.deleteByKey(path);
        } catch (err) {
            logger.errorLog(`Failed to remove vector for ${path}:`, err);
        }
    };

    const commitRemoveBatch = async (paths: string[]) => {
        paths.forEach((path) => {
            _current = StoreOps.remove(_current, path);
        });

        try {
            await provider.deleteBatch(paths);
        } catch (err) {
            logger.errorLog('Batch removal failed:', err);
        }
    };

    const clear = async () => {
        _current = { entries: {} };
        try {
            await provider.clear();
        } catch (err) {
            logger.errorLog('Failed to clear VectorStore:', err);
        }
    };

    return {
        getState: () => _current,
        load,
        commitUpsert,
        commitUpsertBatch,
        commitRemove,
        commitRemoveBatch,
        clear,
    };
};
