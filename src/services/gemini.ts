import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from 'shared/notify';
import type { Result } from 'types';

export type ModelMetadata = {
    readonly contextLength: number;
};

const DEFAULT_CONTEXT_LENGTH = 2048;
export const GEMINI_EMBEDDING_MODEL = 'text-embedding-004';

export class GeminiService {
    private client: GoogleGenerativeAI | null = null;
    private cachedModels: string[] = [GEMINI_EMBEDDING_MODEL];
    private requestQueue: Array<() => Promise<unknown>> = [];
    private isProcessingQueue = false;
    private lastRequestTime = 0;
    private readonly MIN_REQUEST_INTERVAL = 100; // 100ms間隔でレート制限

    constructor(apiKey: string) {
        this.setApiKey(apiKey);
    }

    public setApiKey = (apiKey: string): void => {
        if (apiKey) {
            this.client = new GoogleGenerativeAI(apiKey);
        } else {
            this.client = null;
        }
    };

    public getModels = (): readonly string[] => [...this.cachedModels];

    public reconfigure = (apiKey: string): void => {
        this.setApiKey(apiKey);
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
        const testRes = await this.embed('text-embedding-004', 'test');
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
            value: { contextLength: DEFAULT_CONTEXT_LENGTH },
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
            return {
                ok: false,
                error: 'Gemini API client not initialized',
            };
        }

        try {
            const inputs = Array.isArray(input) ? input : [input];

            // Gemini API はバッチ埋め込みをサポート
            const model = this.client.getGenerativeModel({
                model: GEMINI_EMBEDDING_MODEL,
            });

            const request = {
                content: {
                    parts: inputs.map((text) => ({ text })),
                },
            };

            // @ts-expect-error - embedContent SDK typing does not accept a plain
            // Content object without the 'role' field in v0.11.x
            const result = await model.embedContent(request);

            if (!result.embedding?.values) {
                return {
                    ok: false,
                    error: 'No embedding values in response',
                };
            }

            // 単一のテキストの場合
            if (inputs.length === 1) {
                return {
                    ok: true,
                    value: {
                        embeddings: [result.embedding.values],
                    },
                };
            }

            // 複数テキストの場合はループで処理
            const embeddings: number[][] = [];
            for (const text of inputs) {
                const res = await this.client
                    .getGenerativeModel({ model: GEMINI_EMBEDDING_MODEL })
                    .embedContent(text);

                if (res.embedding?.values) {
                    embeddings.push(res.embedding.values);
                }
            }

            if (embeddings.length !== inputs.length) {
                return {
                    ok: false,
                    error: `Expected ${inputs.length} embeddings, got ${embeddings.length}`,
                };
            }

            return {
                ok: true,
                value: { embeddings },
            };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);

            // レート制限エラーの検出
            if (
                message.includes('RESOURCE_EXHAUSTED') ||
                message.includes('quota')
            ) {
                logger.errorLog(
                    'Gemini API quota exceeded',
                    'Free tier limit reached. Please wait or upgrade.',
                );
            }

            return {
                ok: false,
                error: message,
            };
        }
    };
}
