import {
    type EmbedResponse,
    Ollama,
    type Options,
    type ShowResponse,
} from 'ollama';
import { logger } from 'shared/notify';
import type { Result } from 'types';

export type ModelMetadata = {
    readonly contextLength: number;
};

export type OllamaService = {
    readonly getModels: () => string[];
    readonly fetchModels: () => Promise<void>;
    readonly getModelMetadata: (
        modelName: string,
    ) => Promise<Result<ModelMetadata>>;
    readonly embed: (
        model: string,
        input: string | string[],
        num_ctx?: number,
    ) => Promise<Result<EmbedResponse>>;
    readonly reconfigure: (baseUrl: string) => void;
    readonly abort: () => void;
};

export type ModelName = string;
export type ModelList = ModelName[];

export type ModelService = {
    readonly getModels: () => ModelList;
    readonly fetchModels: () => Promise<void>;
    readonly isLoaded: () => boolean;
};

export const createOllamaService = (initialBaseUrl: string): OllamaService => {
    let ollama = new Ollama({ host: initialBaseUrl });
    let cachedModels: string[] = [];

    const wrap = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
        try {
            return { ok: true, value: await fn() };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: message };
        }
    };

    const getNumeric = (
        info: ShowResponse['model_info'],
        keys: string[],
    ): number | undefined => {
        if (!info) return undefined;
        for (const key of keys) {
            const val: unknown =
                info instanceof Map
                    ? info.get(key)
                    : (info as Record<string, unknown>)[key];
            if (typeof val === 'number') return val;
        }
        return undefined;
    };

    return {
        getModels: () => [...cachedModels],

        reconfigure: (baseUrl: string) => {
            ollama = new Ollama({ host: baseUrl });
        },

        fetchModels: async () => {
            const res = await wrap(() => ollama.list());
            if (res.ok) {
                cachedModels = res.value.models.map((m) => m.name);
            } else {
                logger.errorLog('Failed to fetch models', res.error);
            }
        },

        getModelMetadata: async (modelName: string) => {
            const res = await wrap(() => ollama.show({ model: modelName }));
            if (!res.ok) return res;

            return {
                ok: true,
                value: {
                    contextLength:
                        getNumeric(res.value.model_info, [
                            'llama.context_length',
                            'bert.context_length',
                            'general.context_length',
                        ]) ?? 512,
                },
            };
        },

        embed: async (model, input, num_ctx) =>
            wrap(() =>
                ollama.embed({
                    model,
                    input,
                    truncate: true,
                    options: { num_ctx } as Partial<Options>,
                }),
            ),

        abort: () => ollama.abort(),
    };
};
