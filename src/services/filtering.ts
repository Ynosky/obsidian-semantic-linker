import ignore from 'ignore';
import type { CachedMetadata, MetadataCache, TFile, Vault } from 'obsidian';
import type { SettingParams } from 'types';

export type TagSet = Set<string>;

export type FileTagMap = Map<string, TagSet>;

type Predicate = (file: TFile) => boolean;

export type TagManager = {
    readonly updateFile: (file: TFile, cache: CachedMetadata) => void;
    readonly removeFile: (path: string) => void;
    readonly renameFile: (oldPath: string, newPath: string) => void;
    readonly getFileTagMap: () => FileTagMap;
    readonly getGlobalTags: () => TagSet;
    readonly initialize: (vault: Vault, metadataCache: MetadataCache) => void;
};

export type ExclusionService = {
    readonly isExcluded: Predicate;
    readonly refresh: () => void;
};

type ExclusionContext = {
    readonly settings: () => SettingParams;
    readonly tags: TagManager;
};

export const createTagManager = (): TagManager => {
    const fileTagMap: FileTagMap = new Map();
    let globalTagCache: TagSet = new Set();
    let isDirty = true;

    const getFrontmatterTagArray = (
        fm: NonNullable<CachedMetadata['frontmatter']>,
    ): string[] => {
        const raw: unknown = fm.tags ?? fm.tag;
        if (raw === null || raw === undefined) return [];

        const rawArray = Array.isArray(raw) ? raw : [raw];
        const result: string[] = [];

        for (const item of rawArray) {
            if (typeof item === 'string' || typeof item === 'number') {
                result.push(String(item));
            }
        }

        return result;
    };

    const extractTags = (cache: CachedMetadata): TagSet => {
        const tags: TagSet = new Set();

        const fm = cache.frontmatter;
        if (fm) {
            for (const t of getFrontmatterTagArray(fm)) {
                tags.add(t.replace(/^#/, ''));
            }
        }

        const inline = cache.tags;
        if (!inline) return tags;
        for (const t of inline) {
            tags.add(t.tag.replace(/^#/, ''));
        }

        return tags;
    };

    const rebuildGlobalCache = () => {
        if (!isDirty) return;
        const newSet: TagSet = new Set();
        for (const tags of fileTagMap.values()) {
            for (const tag of tags) {
                newSet.add(tag);
            }
        }
        globalTagCache = newSet;
        isDirty = false;
    };

    return {
        updateFile: (file, cache) => {
            fileTagMap.set(file.path, extractTags(cache));
            isDirty = true;
        },
        removeFile: (path) => {
            if (fileTagMap.delete(path)) isDirty = true;
        },
        renameFile: (oldPath, newPath) => {
            const tags = fileTagMap.get(oldPath);
            if (tags) {
                fileTagMap.set(newPath, tags);
                fileTagMap.delete(oldPath);
            }
        },
        getFileTagMap: () => fileTagMap,
        getGlobalTags: () => {
            rebuildGlobalCache();
            return globalTagCache;
        },
        initialize: (vault, metadataCache) => {
            const files = vault.getMarkdownFiles();
            for (const file of files) {
                const cache = metadataCache.getFileCache(file);
                if (cache) {
                    fileTagMap.set(file.path, extractTags(cache));
                }
            }
            isDirty = true;
        },
    };
};

const createPathMatcher = (patterns: string[]): Predicate => {
    if (patterns.length === 0) return (_: TFile) => false;
    const ig = ignore().add(patterns);
    return (file: TFile) => {
        const path = file.path;
        return !!path && path !== '.' && ig.ignores(path);
    };
};

export const createExclusionService = (
    ctx: ExclusionContext,
): ExclusionService => {
    let cachedPathMatcher: Predicate | null = null;

    const getPathMatcher = (): Predicate => {
        if (cachedPathMatcher !== null) return cachedPathMatcher;
        cachedPathMatcher = createPathMatcher(ctx.settings().excludePatterns);
        return cachedPathMatcher;
    };

    return {
        isExcluded: (file: TFile): boolean => {
            if (getPathMatcher()(file)) return true;

            const excludedTags = ctx.settings().excludedTags;
            if (excludedTags.length === 0) return false;

            const fileTagMap = ctx.tags.getFileTagMap();
            const tags = fileTagMap.get(file.path);
            if (!tags) return false;

            return excludedTags.some((tag) => tags.has(tag));
        },
        refresh: () => {
            cachedPathMatcher = null;
        },
    };
};
