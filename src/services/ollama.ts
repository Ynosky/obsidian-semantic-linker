import { type EmbedResponse, Ollama, type ShowResponse } from 'ollama';
import { logger } from 'shared/notify';
import type { Result } from 'types';

export type ModelMetadata = {
    readonly contextLength: number;
};

type ModelInfo = ShowResponse['model_info'];

const CONTEXT_LENGTH_KEYS = [
    'llama.context_length',
    'bert.context_length',
    'general.context_length',
] as const;

const DEFAULT_CONTEXT_LENGTH = 512;

export class OllamaService {
    private client: Ollama;
    private cachedModels: string[] = [];

    constructor(baseUrl: string) {
        this.client = new Ollama({ host: baseUrl });
    }

    public getModels = (): readonly string[] => [...this.cachedModels];

    public reconfigure = (baseUrl: string): void => {
        this.client = new Ollama({ host: baseUrl });
    };

    public fetchModels = async (): Promise<Result<void>> => {
        const res = await this.tryRequest(() => this.client.list());
        if (res.ok) {
            this.cachedModels = res.value.models.map((m) => m.name);
            return { ok: true, value: undefined };
        }
        logger.errorLog('Failed to fetch models', res.error);
        return res;
    };

    public getModelMetadata = async (
        modelName: string,
    ): Promise<Result<ModelMetadata>> => {
        const res = await this.tryRequest(() =>
            this.client.show({ model: modelName }),
        );
        if (!res.ok) return res;

        const length = this.extractContextLength(
            res.value.model_info,
            CONTEXT_LENGTH_KEYS,
            DEFAULT_CONTEXT_LENGTH,
        );

        return {
            ok: true,
            value: { contextLength: length },
        };
    };

    public embed = (
        model: string,
        input: string | string[],
    ): Promise<Result<EmbedResponse>> => {
        return this.tryRequest(() =>
            this.client.embed({
                model,
                input,
                truncate: false,
            }),
        );
    };

    public abort = (): void => {
        this.client.abort();
    };

    private tryRequest = async <T>(
        operation: () => Promise<T>,
    ): Promise<Result<T>> => {
        try {
            const value = await operation();
            return { ok: true, value };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            return { ok: false, error: message };
        }
    };

    private extractContextLength = (
        info: ModelInfo,
        keys: readonly string[],
        defaultValue: number,
    ): number => {
        if (!info) return defaultValue;

        for (const key of keys) {
            let val: unknown;

            if (info instanceof Map) {
                val = info.get(key);
            } else {
                const rec = info as Record<string, unknown>;
                if (Object.hasOwn(rec, key)) {
                    val = rec[key];
                }
            }

            if (typeof val === 'number') return val;
        }

        return defaultValue;
    };
}
