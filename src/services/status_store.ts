import { createStorageProvider } from 'logic/storage';
import { DB_VERSION } from '../constants';

export type IndexStatus = {
    lastIndexTime: number;
    lastIndexCount: number;
    lastModelUsed: string;
    modelContextLength?: number;
};

const STATUS_ID = 'current-status';

const DEFAULT_STATUS: IndexStatus = {
    lastIndexTime: 0,
    lastIndexCount: 0,
    lastModelUsed: '',
    modelContextLength: 512,
};

type StatusRecord = IndexStatus & { id: string };

export type StatusService = {
    readonly getState: () => IndexStatus;
    readonly update: (update: Partial<IndexStatus>) => Promise<void>;
    readonly load: () => Promise<IndexStatus>;
};

export const createStatusStoreService = (
    dbName: string,
    onUpdate?: () => void,
): StatusService => {
    const provider = createStorageProvider({
        dbName: dbName,
        storeName: 'status',
        version: DB_VERSION,
        keyPath: 'id',
    });

    let _state: IndexStatus = { ...DEFAULT_STATUS };

    return {
        getState: () => ({ ..._state }),

        async load(): Promise<IndexStatus> {
            try {
                const result = await provider.getByKey<StatusRecord>(STATUS_ID);
                if (result) {
                    const { id, ...savedStatus } = result;
                    _state = { ...DEFAULT_STATUS, ...savedStatus };
                }
            } catch (e) {
                console.error('Failed to load status from DB:', e);
            }
            onUpdate?.();
            return _state;
        },

        async update(update: Partial<IndexStatus>): Promise<void> {
            _state = {
                ..._state,
                ...update,
            };
            try {
                await provider.putBatch<StatusRecord>([
                    { ..._state, id: STATUS_ID },
                ]);
            } catch (e) {
                console.error('Failed to save status to DB:', e);
            }
            onUpdate?.();
        },
    };
};
