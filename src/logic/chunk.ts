import { getEncoding } from 'js-tiktoken';

const HEADER_KEYS_BASE = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
const OTHER_SEPARATORS = ['sentence', 'word', 'grapheme'] as const;

type HeaderKey = (typeof HEADER_KEYS_BASE)[number];
type SeparatorLevel = HeaderKey | (typeof OTHER_SEPARATORS)[number];

type HeaderStack = Record<HeaderKey, string>;

type TextChunk = {
    text: string;
    startLine: number;
    endLine: number;
};

type AssemblyState = {
    readonly text: string;
    readonly tokens: number;
    readonly startOffset: number;
};

type Tokenizer = {
    readonly count: (t: string) => number;
    readonly encode: (t: string) => Uint32Array;
    readonly decode: (tokens: Uint32Array) => string;
};

type MarkdownEngine = {
    readonly update: (text: string) => void;
    readonly getBreadcrumb: () => string;
};

type AssemblyEngine = {
    readonly add: (t: string, tokens: number) => void;
    readonly flush: (endOffset: number, breadcrumb: string) => void;
    readonly getTokens: () => number;
    readonly getResult: () => readonly TextChunk[];
};

type ChunkConfig = {
    readonly tokenizer: Tokenizer;
    readonly limit: number;
    readonly overlap: number;
    readonly titlePrefix: string;
    readonly lineStarts: readonly number[];
};

const HEADER_KEYS: readonly HeaderKey[] = HEADER_KEYS_BASE;
const SEPARATORS: readonly SeparatorLevel[] = [
    ...HEADER_KEYS_BASE,
    ...OTHER_SEPARATORS,
];

const REGEX_CACHE: Map<number, RegExp> = new Map();

const SEGMENTER_CACHE: Map<string, Intl.Segmenter> = new Map();

const getHeaderRegex = (depth: number): RegExp => {
    const cached = REGEX_CACHE.get(depth);
    if (cached !== undefined) return cached;
    const rex = new RegExp(`(?=\\n${'#'.repeat(depth)} )`);
    REGEX_CACHE.set(depth, rex);
    return rex;
};

const getSegmenter = (
    granularity: 'sentence' | 'word' | 'grapheme',
): Intl.Segmenter => {
    const cached = SEGMENTER_CACHE.get(granularity);
    if (cached !== undefined) return cached;
    const seg = new Intl.Segmenter(undefined, { granularity });
    SEGMENTER_CACHE.set(granularity, seg);
    return seg;
};

const findLineNumber = (pos: number, lineStarts: readonly number[]): number => {
    let l = 0;
    let r = lineStarts.length - 1;
    let res = 0;
    while (l <= r) {
        const m = (l + r) >> 1;
        if ((lineStarts[m] ?? 0) <= pos) {
            res = m;
            l = m + 1;
        } else {
            r = m - 1;
        }
    }
    return res;
};

const createTokenizer = (): Tokenizer => {
    const encoding = getEncoding('cl100k_base');
    return {
        count: (t) => encoding.encode(t).length,
        encode: (t) => new Uint32Array(encoding.encode(t)),
        decode: (tokens) => encoding.decode(Array.from(tokens)),
    };
};

const createMarkdownEngine = (): MarkdownEngine => {
    let stack: HeaderStack = { h1: '', h2: '', h3: '', h4: '', h5: '', h6: '' };
    return {
        update: (text) => {
            const match = text.match(/^\n?(#{1,6})\s+(.*)/);
            if (match === null) return;
            const depth = match[1]?.length ?? 0;
            if (depth < 1 || depth > 6) return;

            const next = { ...stack };
            const content = (match[2] ?? '').trim();
            HEADER_KEYS.forEach((key, i) => {
                const d = i + 1;
                if (d === depth) next[key] = content;
                else if (d > depth) next[key] = '';
            });
            stack = next;
        },
        getBreadcrumb: () => {
            const parts = [stack.h1, stack.h2, stack.h3].filter(
                (p) => p !== '',
            );
            return parts.length > 0 ? `[Context: ${parts.join(' > ')}]\n` : '';
        },
    };
};

const createAssemblyEngine = (config: ChunkConfig): AssemblyEngine => {
    let state: AssemblyState = { text: '', tokens: 0, startOffset: 0 };
    const chunks: TextChunk[] = [];

    return {
        add: (t, tokens) => {
            state = {
                ...state,
                text: state.text + t,
                tokens: state.tokens + tokens,
            };
        },
        flush: (endOffset, breadcrumb) => {
            const content = state.text.trim();
            if (content === '') return;

            chunks.push({
                text: `${config.titlePrefix}${breadcrumb}${content}`,
                startLine: findLineNumber(state.startOffset, config.lineStarts),
                endLine: findLineNumber(endOffset, config.lineStarts),
            });

            const currentTokens = config.tokenizer.encode(state.text);
            if (currentTokens.length > config.overlap) {
                const overlapText = config.tokenizer.decode(
                    currentTokens.slice(-config.overlap),
                );
                state = {
                    text: overlapText,
                    tokens: config.overlap,
                    startOffset: Math.max(0, endOffset - overlapText.length),
                };
            } else {
                state = { text: '', tokens: 0, startOffset: endOffset };
            }
        },
        getTokens: () => state.tokens,
        getResult: () => chunks,
    };
};

const splitText = (text: string, level: SeparatorLevel): readonly string[] => {
    if (level.startsWith('h')) {
        return text
            .split(getHeaderRegex(Number(level.slice(1))))
            .filter((s) => s !== '');
    }
    const granularity = level as 'sentence' | 'word' | 'grapheme';
    return Array.from(getSegmenter(granularity).segment(text)).map(
        (s) => s.segment,
    );
};

const processSegment = async (
    text: string,
    levelIdx: number,
    offset: number,
    md: MarkdownEngine,
    assembly: AssemblyEngine,
    config: ChunkConfig,
): Promise<void> => {
    if (offset % 5000 === 0) await new Promise((r) => setTimeout(r, 0));

    const level = SEPARATORS[levelIdx];
    if (level === undefined) return;

    if (level.startsWith('h')) md.update(text);

    const breadcrumb = md.getBreadcrumb();
    const cost = config.tokenizer.count(breadcrumb);
    const targetTokens = config.tokenizer.count(text);

    if (assembly.getTokens() + targetTokens <= config.limit - cost) {
        assembly.add(text, targetTokens);
        return;
    }

    const nextIdx = levelIdx + 1;
    if (nextIdx < SEPARATORS.length) {
        const parts = splitText(text, level);
        if (parts.length > 1) {
            let currentOffset = offset;
            for (const part of parts) {
                await processSegment(
                    part,
                    nextIdx,
                    currentOffset,
                    md,
                    assembly,
                    config,
                );
                currentOffset += part.length;
            }
            return;
        }
        await processSegment(text, nextIdx, offset, md, assembly, config);
        return;
    }

    if (assembly.getTokens() > 0) assembly.flush(offset, breadcrumb);
    assembly.add(text, targetTokens);
    if (assembly.getTokens() >= config.limit - cost) {
        assembly.flush(offset + text.length, breadcrumb);
    }
};

const getLineStarts = (text: string): readonly number[] => {
    const positions: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            positions.push(i + 1);
        }
    }
    return positions;
};

export const createChunks = async (
    text: string,
    maxTokens: number,
    safetyMargin: number,
    overlapRatio: number,
    title?: string,
): Promise<TextChunk[]> => {
    if (text === '') return [];

    const tokenizer = createTokenizer();
    const titlePrefix = title !== undefined ? `Title: ${title}\nContent: ` : '';
    const limit = Math.floor(
        (maxTokens - tokenizer.count(titlePrefix)) * safetyMargin,
    );

    const config: ChunkConfig = {
        tokenizer,
        limit,
        overlap: Math.floor(limit * overlapRatio),
        titlePrefix,
        lineStarts: getLineStarts(text),
    };

    const md = createMarkdownEngine();
    const assembly = createAssemblyEngine(config);

    await processSegment(text, 0, 0, md, assembly, config);
    assembly.flush(text.length, md.getBreadcrumb());

    return [...assembly.getResult()];
};
