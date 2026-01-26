export type CleaningStrategy = 'preview' | 'semantic' | 'frontmatter';

export const Cleaners = {
    preview: (text: string): string =>
        text
            .replace(/^---\n[\s\S]*?\n---\n/, '') // プロパティ(YAML) -> 削除
            .replace(/\n{2,}/g, '\n') // 連続改行 -> 1行
            .trim(),

    semantic: (text: string): string =>
        text
            // Obsidian comments
            .replace(/%%[\s\S]*?%%/g, '')

            // Footnote definitions (e.g., [^1]: description)
            .replace(/^[ \t]*\[\^[^\]]+\]:.*$/gm, '')

            // Footnote references (e.g., [^1])
            .replace(/\[\^[^\]]+\]/g, '')

            // Thematic breaks (e.g., ---, ***)
            .replace(/^[ \t]*([-*_]){3,}[ \t]*$/gm, '')

            // List markers (e.g., -, *, 1.)
            .replace(/^[ \t]*([-*+]|[0-9]+\.)[ \t]+/gm, '$1 ')

            // Internal links / Embeds (e.g., ![[note#heading|alias]])
            // remove embed marker
            .replace(/!\[\[/g, '[[')
            // [[title|alias]] -> alias
            .replace(/\[\[(?:.*\|)(.*?)\]\]/g, '$1')
            // [[title#heading]] -> title heading
            .replace(/\[\[(.*?)\]\]/g, (_, content: string) =>
                content.replace(/[#^]/g, ' '),
            )

            // External links & URLs (e.g., [title](url))
            // ![alt](URL) -> alt
            .replace(/!\[([^\]]*?)\]\(.*?\)/g, '$1')
            // ![title](URL) -> title
            .replace(/\[([^\]]*?)\]\(.*?\)/g, '$1')
            // Plain URLs -> remove
            .replace(/https?:\/\/[^\s)]+/g, '')

            // HTML tags
            .replace(/<[^>]*>/g, '')

            // Decorations (e.g., **, ==, #, >)
            .replace(/(\*\*|__|==|~~|`|#|>)/g, '')

            // Excessive horizontal whitespaces
            .replace(/[ \t]{2,}/g, ' ')

            // Trailing whitespaces
            .replace(/[ \t]+$/gm, '')

            // Excessive newlines (Paragraphs to single line)
            .replace(/\n{2,}/g, '\n')

            .trim(),

    frontmatter: (text: string): string =>
        text.replace(/^---\n[\s\S]*?\n---\n/g, ''),
} as const;

export const cleanText = (text: string, strategy: CleaningStrategy): string => {
    return Cleaners[strategy](text);
};
