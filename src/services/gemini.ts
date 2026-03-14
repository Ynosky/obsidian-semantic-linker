import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from 'shared/notify';
import type { Result } from 'types';

export type ModelMetadata = {
    readonly contextLength: number;
};

export const GEMINI_CONTEXT_LENGTH = 2048;
export const GEMINI_EMBEDDING_MODEL = 'text-embedding-004';

export class GeminiService {
    private client: GoogleGenerativeAI | null = null;
    private requestQueue: Array<() => Promise<unknown>> = [];
    private isProcessingQueue = false;
    private lastRequestTime = 0;
    private readonly MIN_REQUEST_INTERVAL = 100; // 100ms間隔でレート制限

    constructor(apiKey: string) {
        if (apiKey) {
            this.client = new GoogleGenerativeAI(apiKey);
        }
    }

    public getModels = (): readonly string[] => [GEMINI_EMBEDDING_MODEL];

    public reconfigure = (apiKey: string): void => {
        this.client = apiKey ? new GoogleGenerativeAI(apiKey) : null;
    };

    public fetchModels = async (): Promise<Result<void>> => {
        // Geminiは1つのembeddingモデルのみ
        // 単純に接続確認として機能
        if (!this.client) {
            return {
                ok: false,
                error: 'API key not configured',
            };
        }

        // API キーの妥当性をチェック
        const testRes = await this.embed(GEMINI_EMBEDDING_MODEL, 'test');
        if (!testRes.ok) {
            logger.errorLog('Failed to verify Gemini API', testRes.error);
            return testRes;
        }

        return { ok: true, value: undefined };
    };

    public getModelMetadata = async (
        _modelName: string,
    ): Promise<Result<ModelMetadata>> => {
        return {
            ok: true,
            value: { contextLength: GEMINI_CONTEXT_LENGTH },
        };
    };

    public embed = (
        _model: string,
        input: string | string[],
    ): Promise<Result<{ embeddings: number[][] }>> => {
        return this.queueRequest(() => this.doEmbed(input));
    };

    public abort = (): void => {
        this.requestQueue = [];
    };

    private queueRequest = async <T>(
        operation: () => Promise<Result<T>>,
    ): Promise<Result<T>> => {
        return new Promise((resolve) => {
            this.requestQueue.push(async () => {
                const result = await operation();
                resolve(result);
            });

            if (!this.isProcessingQueue) {
                void this.processQueue();
            }
        });
    };

    private processQueue = async (): Promise<void> => {
        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const now = Date.now();
            const elapsed = now - this.lastRequestTime;

            if (elapsed < this.MIN_REQUEST_INTERVAL) {
                await new Promise((resolve) =>
                    setTimeout(resolve, this.MIN_REQUEST_INTERVAL - elapsed),
                );
            }

            const operation = this.requestQueue.shift();
            if (operation) {
                await operation();
            }

            this.lastRequestTime = Date.now();
        }

        this.isProcessingQueue = false;
    };

    private doEmbed = async (
        input: string | string[],
    ): Promise<Result<{ embeddings: number[][] }>> => {
        if (!this.client) {
            return { ok: false, error: 'Gemini API client not initialized' };
        }
        try {
            if (typeof input === 'string') {
                return await this.embedSingle(this.client, input);
            }
            return input.length === 1 && input[0] !== undefined
                ? await this.embedSingle(this.client, input[0])
                : await this.embedBatch(this.client, input);
        } catch (error) {
            return { ok: false, error: this.handleEmbedError(error) };
        }
    };

    private embedSingle = async (
        client: GoogleGenerativeAI,
        text: string,
    ): Promise<Result<{ embeddings: number[][] }>> => {
        try {
            const model = client.getGenerativeModel({
                model: GEMINI_EMBEDDING_MODEL,
            });
            const result = await model.embedContent(text);
            const values = result.embedding?.values;
            if (!values || values.length === 0) {
                return { ok: false, error: 'No embedding values in response' };
            }
            return { ok: true, value: { embeddings: [values] } };
        } catch (error) {
            return { ok: false, error: this.handleEmbedError(error) };
        }
    };

    private embedBatch = async (
        client: GoogleGenerativeAI,
        inputs: string[],
    ): Promise<Result<{ embeddings: number[][] }>> => {
        try {
            const model = client.getGenerativeModel({
                model: GEMINI_EMBEDDING_MODEL,
            });
            const batchResult = await model.batchEmbedContents({
                requests: inputs.map((text) => ({
                    model: GEMINI_EMBEDDING_MODEL,
                    content: { role: 'user', parts: [{ text }] },
                })),
            });

            if (
                !batchResult.embeddings ||
                batchResult.embeddings.length === 0
            ) {
                return {
                    ok: false,
                    error: 'No embeddings returned from batch request',
                };
            }

            return {
                ok: true,
                value: {
                    embeddings: batchResult.embeddings.map((e) => e.values),
                },
            };
        } catch (error) {
            return { ok: false, error: this.handleEmbedError(error) };
        }
    };

    private handleEmbedError = (error: unknown): string => {
        const message = error instanceof Error ? error.message : String(error);
        if (
            message.includes('RESOURCE_EXHAUSTED') ||
            message.includes('quota')
        ) {
            logger.errorLog(
                'Gemini API quota exceeded',
                'Free tier limit reached. Please wait or upgrade.',
            );
        }
        return message;
    };
}
