import { createChunks } from 'logic/chunk';
import { cleanText } from 'logic/cleaners';
import { averageEmbeddings } from 'logic/vector_operations';
import { debounce, type Notice, TFile, type Vault } from 'obsidian';
import type { EmbedResponse } from 'ollama';
import { logger } from '../shared/notify';
import { getTitleFromPath } from '../shared/utils';
import type { EmbeddedChunk, Result, SettingParams } from '../types';
import type { ExclusionService } from './filtering';
import type { OllamaService } from './ollama';
import type { StatusService } from './status_store';
import { StoreOps, type VectorStoreService } from './vector_store';

type ProgressCounter = {
    readonly increment: (count?: number) => number;
    readonly get: () => number;
};

const createProgressCounter = (): ProgressCounter => {
    let count = 0;
    return {
        increment: (c = 1) => {
            count += c;
            return count;
        },
        get: () => count,
    };
};

type IndexProgress = {
    total: number;
    processed: number;
    currentFile: string;
};

type BatchItemResult = {
    file: TFile;
    chunks: EmbeddedChunk[];
};

export type IndexingService = {
    readonly isBusy: () => boolean;
    readonly stop: () => void;
    readonly runFullIndex: (force?: boolean) => Promise<void>;
    readonly indexFile: (file: TFile, showNotice?: boolean) => Promise<void>;
    readonly queueAutoIndex: (file: TFile) => void;
    readonly handleDelete: (file: TFile) => Promise<void>;
    readonly handleRename: (file: TFile, oldPath: string) => Promise<void>;
    readonly clearIndex: () => Promise<void>;
    readonly applyExclusion: () => Promise<void>;
    readonly reconfigureDebounce: () => void;
    readonly getEmbeddings: (text: string) => Promise<Result<number[]>>;
};

const isTruncated = (res: EmbedResponse, limit: number): boolean =>
    (res.prompt_eval_count ?? 0) >= limit;

const updateNotice = (notice: Notice, p: IndexProgress) => {
    const pct = Math.round((p.processed / p.total) * 100);
    notice.setMessage(
        `Indexing: ${pct}% (${p.processed}/${p.total})\n${p.currentFile}`,
    );
};

export const createIndexingService = (
    vault: Vault,
    ollama: OllamaService,
    vector: VectorStoreService,
    status: StatusService,
    exclusion: ExclusionService,
    getSettings: () => SettingParams,
    getIsTyping: () => boolean,
    onIndexFinished: () => void,
): IndexingService => {
    let _active = false;
    let _stopping = false;
    let _autoIndexFn: ((file: TFile) => void) | null = null;

    const updateStats = async () => {
        const settings = getSettings();
        await status.update({
            lastIndexTime: Date.now(),
            lastIndexCount: Object.keys(vector.getState().entries).length,
            lastModelUsed: settings.ollamaModel,
        });
        onIndexFinished();
    };

    const embedDocument = async (
        text: string,
        title: string,
    ): Promise<Result<number[]>> => {
        const settings = getSettings();
        const modelState = status.getState();
        const maxTokens = modelState.modelContextLength || 512;
        let currentLimit = maxTokens;
        const maxRetries = settings.maxRetries || 5;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const chunks = await createChunks(
                text,
                currentLimit,
                settings.safetyMargin,
                settings.overlapRatio,
                title,
            );

            const results = await Promise.all(
                chunks.map((c) =>
                    ollama.embed(settings.ollamaModel, c.text, maxTokens),
                ),
            );
            const errorRes = results.find((r) => !r.ok);
            if (errorRes && !errorRes.ok) {
                return { ok: false, error: errorRes.error };
            }

            const truncatedIndex = results.findIndex(
                (r) => r.ok && isTruncated(r.value, maxTokens),
            );

            if (truncatedIndex !== -1) {
                currentLimit = Math.floor(
                    currentLimit * settings.reductionRatio,
                );
                continue;
            }

            const vectors = results
                .map((r) => (r.ok ? r.value.embeddings?.[0] : null))
                .filter((v): v is number[] => v !== null && v !== undefined);

            if (vectors.length > 0) {
                const average = await averageEmbeddings(vectors);
                return { ok: true, value: average };
            }
            return { ok: false, error: 'No embeddings generated' };
        }

        return {
            ok: false,
            error: 'Failed to embed after retries due to context limits',
        };
    };

    const createEmbeddingForFile = async (
        file: TFile,
    ): Promise<Result<BatchItemResult>> => {
        try {
            const settings = getSettings();
            let content = await vault.read(file);
            if (!settings.includeFrontmatter) {
                content = cleanText(content, 'frontmatter');
            }
            content = cleanText(content, 'semantic');

            if (content.trim().length === 0) {
                return { ok: true, value: { file, chunks: [] } };
            }

            const result = await embedDocument(
                content,
                getTitleFromPath(file.path),
            );

            if (!result.ok) {
                return { ok: false, error: result.error };
            }

            return {
                ok: true,
                value: {
                    file,
                    chunks: [
                        {
                            text: content,
                            embedding: result.value,
                            startLine: 0,
                            endLine: content.split('\n').length - 1,
                        },
                    ],
                },
            };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    };

    const processBatch = async (
        batch: TFile[],
        total: number,
        processed: ProgressCounter,
        notice: Notice,
    ) => {
        const tasks = batch.map(async (file) => {
            const result = await createEmbeddingForFile(file);

            processed.increment();
            updateNotice(notice, {
                total,
                processed: processed.get(),
                currentFile: file.path,
            });

            return { file, result };
        });
        const resultsWithFile = await Promise.all(tasks);

        const validItems: BatchItemResult[] = [];
        resultsWithFile.forEach(({ file, result }) => {
            if (result.ok) {
                if (result.value.chunks.length > 0) {
                    validItems.push(result.value);
                }
            } else {
                logger.errorLog(
                    `Failed to process ${file.path}: ${result.error}`,
                );
            }
        });

        if (validItems.length > 0) {
            await vector.commitUpsertBatch(validItems);
        }
    };

    const getPendingFiles = (force: boolean): TFile[] => {
        return vault
            .getMarkdownFiles()
            .filter(
                (f) =>
                    !exclusion.isExcluded(f) &&
                    (force || StoreOps.isStale(vector.getState(), f)),
            );
    };

    const processIndexingLoop = async (
        files: TFile[],
        parallelCount: number,
        processed: ProgressCounter,
        notice: Notice,
    ) => {
        for (let i = 0; i < files.length; i += parallelCount) {
            if (_stopping) break;
            const batch = files.slice(i, i + parallelCount);
            await processBatch(batch, files.length, processed, notice);
        }
    };

    const runFullIndex = async (force = false) => {
        if (_active) return;

        const files = getPendingFiles(force);

        if (force) {
            logger.info('Clearing existing index for full re-indexing...');
            await vector.clear();
        }

        if (files.length === 0) {
            logger.info('Index is already up to date.');
            return;
        }

        _active = true;
        _stopping = false;

        const notice = logger.progress(
            force ? 'Re-indexing all notes...' : 'Updating index...',
        );
        const processed = createProgressCounter();
        const parallelCount = getSettings().parallelIndexingCount || 1;

        try {
            // 切り出した関数を呼び出す
            await processIndexingLoop(files, parallelCount, processed, notice);
            await updateStats();
        } catch (e) {
            logger.error('Fatal error during indexing', e);
        } finally {
            _active = false;
            _stopping = false;
            notice.hide();
            logger.info('Indexing finished.');
        }
    };

    const indexFile = async (file: TFile, showNotice = false) => {
        if (file.extension !== 'md') return;
        const result = await createEmbeddingForFile(file);

        if (result.ok) {
            if (result.value.chunks.length > 0) {
                await vector.commitUpsert(file, result.value.chunks);
                await updateStats();
                if (showNotice) logger.info(`Indexed: ${file.basename}`);
            }
        } else {
            logger.errorLog(`Failed to index ${file.path}: ${result.error}`);
        }
    };

    const applyExclusion = async () => {
        const currentStore = vector.getState();
        const toRemove = Object.keys(currentStore.entries).filter((path) => {
            const file = vault.getAbstractFileByPath(path);
            return file instanceof TFile ? exclusion.isExcluded(file) : false;
        });

        if (toRemove.length > 0) {
            await vector.commitRemoveBatch(toRemove);
            await updateStats();
            logger.info(
                `Removed ${toRemove.length} excluded files from index.`,
            );
        }
    };

    return {
        isBusy: () => _active,
        stop: () => {
            _stopping = true;
        },
        runFullIndex,
        indexFile,
        queueAutoIndex: (file) => {
            if (!_autoIndexFn) {
                _autoIndexFn = debounce((f: TFile) => {
                    if (getIsTyping()) {
                        _autoIndexFn?.(f);
                        return;
                    }
                    void indexFile(f);
                }, getSettings().fileProcessingDelay);
            }
            _autoIndexFn(file);
        },
        handleDelete: async (file) => {
            await vector.commitRemove(file.path);
            await updateStats();
        },
        handleRename: async (file, oldPath) => {
            await vector.commitRemove(oldPath);
            await indexFile(file);
        },
        clearIndex: async () => {
            await vector.clear();
            await updateStats();
            logger.info('Index cleared.');
        },
        applyExclusion,
        reconfigureDebounce: () => {
            _autoIndexFn = null;
        },
        getEmbeddings: (text: string) => embedDocument(text, 'Search Query'),
    };
};
