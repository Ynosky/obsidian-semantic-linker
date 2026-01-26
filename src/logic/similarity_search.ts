import type {
    EmbeddedChunk,
    SemanticSearchResult,
    SettingParams,
    Vector,
    VectorStore,
} from 'types';

const sortResults = (results: SemanticSearchResult[]): SemanticSearchResult[] =>
    results.sort((a, b) => b.similarity - a.similarity);

const calcSimilarity = (a: Vector, b: Vector): number => {
    const len = a.length;
    if (len !== b.length || len === 0) return 0;

    let dot = 0,
        normA = 0,
        normB = 0;
    for (let i = 0; i < len; i++) {
        const va = a[i] ?? 0,
            vb = b[i] ?? 0;
        dot += va * vb;
        normA += va * va;
        normB += vb * vb;
    }

    const mag = Math.sqrt(normA) * Math.sqrt(normB);
    return mag === 0 ? 0 : dot / mag;
};

const findTopChunk = (query: Vector, chunks: readonly EmbeddedChunk[]) => {
    let maxScore = -1;
    let bestChunk: EmbeddedChunk | undefined;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;

        const score = calcSimilarity(query, chunk.embedding);
        if (score > maxScore) {
            maxScore = score;
            bestChunk = chunk;
        }
    }
    return { score: maxScore, chunk: bestChunk };
};

export const searchSimilar = (
    query: Vector,
    store: VectorStore,
    settings: SettingParams,
    excludePaths: Set<string>,
    limit: number,
    minThreshold?: number,
): SemanticSearchResult[] => {
    const threshold = minThreshold ?? settings.threshold;
    const results: SemanticSearchResult[] = [];
    const entries = store.entries;

    for (const path of Object.keys(entries)) {
        if (!path || excludePaths.has(path)) continue;

        const entry = entries[path];
        if (!entry?.chunks?.length) continue;

        const { score, chunk } = findTopChunk(query, entry.chunks);

        if (score >= threshold && chunk) {
            results.push({
                path,
                similarity: score,
                matchedText: chunk.text,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
            });
        }
    }

    return sortResults(results).slice(0, limit);
};
