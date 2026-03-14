import { createStorageProvider } from 'logic/storage';
import { logger } from 'shared/notify';
import { DB_VERSION } from '../constants';

export type IndexStatus = {
    readonly lastIndexTime: number;
    readonly lastIndexCount: number;
    readonly lastModelUsed: string;
    readonly modelContextLength?: number;
};

type StatusRecord = IndexStatus & { readonly id: string };

const STATUS_ID = 'current-status';

const DEFAULT_STATUS: IndexStatus = {
    lastIndexTime: 0,
    lastIndexCount: 0,
    lastModelUsed: '',
    modelContextLength: 512,
};

export class StatusService {
    private cachedState: IndexStatus = { ...DEFAULT_STATUS };
    private provider: ReturnType<typeof createStorageProvider>;
    private onUpdate?: () => void;

    constructor(dbName: string, onUpdate?: () => void) {
        this.provider = createStorageProvider({
            dbName,
            storeName: 'status',
            version: DB_VERSION,
            keyPath: 'id',
        });
        this.onUpdate = onUpdate;
    }

    public getState = (): IndexStatus => ({ ...this.cachedState });

    public load = async (): Promise<IndexStatus> => {
        try {
            const result =
                await this.provider.getByKey<StatusRecord>(STATUS_ID);
            if (result) {
                const savedStatus = { ...result };
                delete (savedStatus as any).id;
                this.cachedState = { ...DEFAULT_STATUS, ...savedStatus };
            }
        } catch (error) {
            logger.warnLog('Failed to load status from DB:', error);
        }

        this.onUpdate?.();
        return { ...this.cachedState };
    };

    public update = async (changes: Partial<IndexStatus>): Promise<void> => {
        this.cachedState = {
            ...this.cachedState,
            ...changes,
        };

        try {
            await this.provider.putBatch<StatusRecord>([
                { ...this.cachedState, id: STATUS_ID },
            ]);
        } catch (error) {
            logger.warnLog('Failed to save status to DB:', error);
        }

        this.onUpdate?.();
    };
}
