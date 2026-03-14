import { createStorageProvider } from 'logic/storage';
import type { TFile } from 'obsidian';
import { DB_VERSION } from '../constants';
import { logger } from '../shared/notify';
import type {
    EmbeddedChunk,
    EmbeddedNote,
    Vector,
    VectorStore,
} from '../types';

export type VectorStoreBatchItem = {
    readonly file: TFile;
    readonly chunks: readonly EmbeddedChunk[];
    readonly avgEmbedding: Vector;
};

export const StoreOps = {
    upsert: (
        store: VectorStore,
        file: TFile,
        chunks: readonly EmbeddedChunk[],
        avgEmbedding: Vector,
    ): VectorStore => ({
        ...store,
        entries: {
            ...store.entries,
            [file.path]: {
                path: file.path,
                mtime: file.stat.mtime,
                chunks,
                avgEmbedding,
            },
        },
    }),

    remove: (store: VectorStore, path: string): VectorStore => {
        const rest = { ...store.entries };
        delete rest[path];
        return { ...store, entries: rest };
    },

    isStale: (store: VectorStore, file: TFile): boolean => {
        const entry = store.entries[file.path];
        if (!entry) return true;
        if (entry.mtime !== file.stat.mtime) return true;
        if (!entry.chunks) return true;
        return false;
    },
} as const;

export class VectorStoreService {
    private cachedStore: VectorStore = { entries: {} };
    private provider: ReturnType<typeof createStorageProvider>;

    constructor(dbName: string) {
        this.provider = createStorageProvider({
            dbName,
            storeName: 'vectors',
            version: DB_VERSION,
            keyPath: 'path',
        });
    }

    public getState = (): VectorStore => {
        return this.cachedStore;
    };

    public load = async (): Promise<void> => {
        try {
            const results = await this.provider.getAll<EmbeddedNote>();
            const entries = Object.fromEntries(results.map((e) => [e.path, e]));
            this.cachedStore = { entries };
        } catch (error) {
            logger.errorLog('Failed to load VectorStore:', error);
            this.cachedStore = { entries: {} };
        }
    };

    public commitUpsert = async (
        file: TFile,
        chunks: readonly EmbeddedChunk[],
        avgEmbedding: Vector,
    ): Promise<void> => {
        this.cachedStore = StoreOps.upsert(
            this.cachedStore,
            file,
            chunks,
            avgEmbedding,
        );

        const entry: EmbeddedNote = {
            path: file.path,
            mtime: file.stat.mtime,
            chunks: [...chunks],
            avgEmbedding,
        };

        try {
            await this.provider.putBatch<EmbeddedNote>([entry]);
        } catch (error) {
            logger.errorLog(`Failed to save vector for ${file.path}:`, error);
        }
    };

    public commitUpsertBatch = async (
        items: readonly VectorStoreBatchItem[],
    ): Promise<void> => {
        if (items.length === 0) return;

        items.forEach(({ file, chunks, avgEmbedding }) => {
            this.cachedStore = StoreOps.upsert(
                this.cachedStore,
                file,
                chunks,
                avgEmbedding,
            );
        });

        const dbEntries: EmbeddedNote[] = items.map(
            ({ file, chunks, avgEmbedding }) => ({
                path: file.path,
                mtime: file.stat.mtime,
                chunks: [...chunks],
                avgEmbedding,
            }),
        );

        try {
            await this.provider.putBatch<EmbeddedNote>(dbEntries);
        } catch (error) {
            logger.errorLog('Batch update failed:', error);
        }
    };

    public commitRemove = async (path: string): Promise<void> => {
        this.cachedStore = StoreOps.remove(this.cachedStore, path);
        try {
            await this.provider.deleteByKey(path);
        } catch (error) {
            logger.errorLog(`Failed to remove vector for ${path}:`, error);
        }
    };

    public commitRemoveBatch = async (
        paths: readonly string[],
    ): Promise<void> => {
        if (paths.length === 0) return;

        paths.forEach((path) => {
            this.cachedStore = StoreOps.remove(this.cachedStore, path);
        });

        try {
            await this.provider.deleteBatch(paths);
        } catch (error) {
            logger.errorLog('Batch removal failed:', error);
        }
    };

    public clear = async (): Promise<void> => {
        this.cachedStore = { entries: {} };
        try {
            await this.provider.clear();
        } catch (error) {
            logger.errorLog('Failed to clear VectorStore:', error);
        }
    };
}
