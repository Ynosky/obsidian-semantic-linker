import { cleanText } from 'logic/cleaners';
import { searchSimilar } from 'logic/similarity_search';
import { averageEmbeddings } from 'logic/vector_operations';
import { Component, type MarkdownView, setIcon, TFile } from 'obsidian';
import type MainPlugin from '../main';
import { formatPercent, getTitleFromPath } from '../shared/utils';
import type { SemanticSearchResult } from '../types';

type PreviewState = {
    isOpen: boolean;
    element: HTMLElement;
    toggle: HTMLElement;
};

const createOpenState = (evt: MouseEvent, line?: number) => {
    const newLeaf = evt.ctrlKey || evt.metaKey;
    const state = line !== undefined ? { eState: { line } } : undefined;
    return { newLeaf, state };
};

const searchByFile = async (
    plugin: MainPlugin,
    file: TFile,
): Promise<SemanticSearchResult[]> => {
    const entry = plugin.vectorStoreService.getState().entries[file.path];
    if (!entry || entry.chunks.length === 0) return [];

    const vector = await averageEmbeddings(
        entry.chunks.map((c) => c.embedding),
        plugin.settings.introWeight,
    );

    const excluded = plugin.getLinkedFiles(file);
    excluded.add(file.path);

    return searchSimilar(
        vector,
        plugin.vectorStoreService.getState(),
        plugin.settings,
        excluded,
        plugin.settings.sidebarLimit,
    );
};

const enableDrag = (el: HTMLElement, title: string) => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (evt) => {
        if (!evt.dataTransfer) return;
        evt.dataTransfer.setData('text/plain', `[[${title}]]`);
        evt.dataTransfer.dropEffect = 'copy';
    });
};

const animatePreview = (state: PreviewState) => {
    const { isOpen, element, toggle } = state;
    setIcon(toggle, isOpen ? 'chevron-down' : 'chevron-right');

    if (isOpen) {
        element.removeClass('hidden');
        requestAnimationFrame(() => {
            element.removeClass(
                'opacity-0',
                '-translate-y-1',
                'pointer-events-none',
            );
            element.addClass(
                'opacity-100',
                'translate-y-0',
                'pointer-events-auto',
            );
        });
    } else {
        element.removeClass(
            'opacity-100',
            'translate-y-0',
            'pointer-events-auto',
        );
        element.addClass('opacity-0', '-translate-y-1', 'pointer-events-none');
        setTimeout(() => {
            if (element.hasClass('opacity-0')) {
                element.addClass('hidden');
            }
        }, 200);
    }
};

export class InlineSemanticView extends Component {
    private readingContainerEl: HTMLElement;
    private readingContentEl: HTMLElement;
    private editingContainerEl: HTMLElement;
    private editingContentEl: HTMLElement;
    private lastRenderedPath: string | null = null;
    private lastRenderedMtime: number | null = null;
    private isCollapsed = false;
    private paddingObserver: MutationObserver | null = null;

    constructor(
        private view: MarkdownView,
        private plugin: MainPlugin,
    ) {
        super();
        const reading = this.createContainer();
        this.readingContainerEl = reading.container;
        this.readingContentEl = reading.content;

        const editing = this.createContainer();
        this.editingContainerEl = editing.container;
        this.editingContentEl = editing.content;
    }

    private createContainer(): {
        container: HTMLElement;
        content: HTMLElement;
    } {
        const container = document.createElement('div');
        container.addClasses([
            'semantic-linker-inline-container',
            'border-t',
            'border-[var(--background-modifier-border)]',
            'my-4',
            'pt-4',
            'w-[var(--line-width)]',
            '!mx-[var(--content-margin)]',
        ]);

        const content = container.createDiv({
            cls: 'semantic-linker-inline-content',
        });

        return { container, content };
    }

    onload() {
        setTimeout(() => {
            this.attachToView();
        }, 100);

        void this.update();

        this.registerEvent(
            this.plugin.app.workspace.on('file-open', () => {
                void this.update();
            }),
        );

        this.registerEvent(
            this.plugin.app.vault.on('modify', (file) => {
                if (file === this.view.file) {
                    void this.update();
                }
            }),
        );

        this.registerEvent(
            this.plugin.events.on('semantic-linker:refresh-views', () => {
                void this.update(true);
            }),
        );
    }

    private attachToView() {
        const contentEl = this.view.contentEl;

        const footer = contentEl.querySelector('.mod-footer');
        if (footer && this.readingContainerEl.parentElement !== footer) {
            footer.appendChild(this.readingContainerEl);
        }

        const cmSizer = contentEl.querySelector('.cm-sizer');
        if (cmSizer && this.editingContainerEl.parentElement !== cmSizer) {
            cmSizer.appendChild(this.editingContainerEl);
            this.setupPaddingObserver();
        }
    }

    private setupPaddingObserver() {
        this.disconnectObserver();

        const contentEl = this.view.contentEl;
        const cmContent = contentEl.querySelector('.cm-content') as HTMLElement;
        if (!cmContent) return;

        this.paddingObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (
                    mutation.type === 'attributes' &&
                    mutation.attributeName === 'style'
                ) {
                    this.syncPadding();
                }
            }
        });

        this.paddingObserver.observe(cmContent, {
            attributes: true,
            attributeFilter: ['style'],
        });

        this.syncPadding();
    }

    private disconnectObserver() {
        if (this.paddingObserver) {
            this.paddingObserver.disconnect();
            this.paddingObserver = null;
        }
    }

    private syncPadding() {
        const contentEl = this.view.contentEl;
        const cmContent = contentEl.querySelector('.cm-content') as HTMLElement;
        if (!cmContent || !this.editingContainerEl) return;

        const paddingBottom = cmContent.style.paddingBottom;
        if (paddingBottom && paddingBottom !== '0px') {
            this.editingContainerEl.setCssProps({
                'padding-bottom': paddingBottom,
            });
            cmContent.setCssProps({ 'padding-bottom': '0px' });
        }
    }

    onunload() {
        this.disconnectObserver();

        const cmContent = this.view.contentEl.querySelector(
            '.cm-content',
        ) as HTMLElement;

        if (cmContent && this.editingContainerEl.style.paddingBottom) {
            cmContent.setCssProps({
                'padding-bottom': this.editingContainerEl.style.paddingBottom,
            });
        }

        this.readingContainerEl.remove();
        this.editingContainerEl.remove();
    }

    private async update(force = false) {
        const file = this.view.file;

        if (!file) {
            this.readingContainerEl.hide();
            this.editingContainerEl.hide();
            return;
        }

        this.attachToView();
        this.syncPadding();

        if (this.plugin.exclusionService.isExcluded(file)) {
            this.readingContainerEl.hide();
            this.editingContainerEl.hide();
            return;
        }

        if (
            !force &&
            this.lastRenderedPath === file.path &&
            this.lastRenderedMtime === file.stat.mtime
        ) {
            return;
        }

        this.lastRenderedPath = file.path;
        this.lastRenderedMtime = file.stat.mtime;

        const results = await searchByFile(this.plugin, file);
        this.render(results, file);
        this.readingContainerEl.show();
        this.editingContainerEl.show();
    }

    private render(results: SemanticSearchResult[], file: TFile) {
        this.renderToContainer(this.readingContentEl, results, file);
        this.renderToContainer(this.editingContentEl, results, file);
    }

    private renderToContainer(
        contentEl: HTMLElement,
        results: SemanticSearchResult[],
        file: TFile,
    ) {
        contentEl.empty();

        const header = contentEl.createDiv({
            cls: 'flex items-center gap-2 mb-3 cursor-pointer py-1',
        });

        const toggleIcon = header.createDiv({
            cls: 'flex items-center justify-center w-6 h-6 shrink-0 transition-transform duration-200',
        });
        setIcon(
            toggleIcon,
            this.isCollapsed ? 'chevron-right' : 'chevron-down',
        );

        header.createDiv({
            text: 'Semantic linker',
            cls: 'text-sm font-medium text-[var(--text-normal)] m-0',
        });

        header.createDiv({
            text: `${results.length}`,
            cls: 'text-xs text-[var(--text-muted)] bg-[var(--background-secondary)] px-2 py-0.5 rounded-[12px]',
        });

        const resultsContainer = contentEl.createDiv({
            cls: this.isCollapsed ? 'hidden' : 'block',
        });

        header.onclick = () => {
            this.isCollapsed = !this.isCollapsed;
            if (this.isCollapsed) {
                resultsContainer.removeClass('block');
                resultsContainer.addClass('hidden');
            } else {
                resultsContainer.removeClass('hidden');
                resultsContainer.addClass('block');
            }
            setIcon(
                toggleIcon,
                this.isCollapsed ? 'chevron-right' : 'chevron-down',
            );
        };

        if (results.length === 0) {
            this.renderEmpty(resultsContainer, file);
            return;
        }

        for (const result of results) {
            this.renderItem(resultsContainer, result);
        }
    }

    private renderEmpty(container: HTMLElement, file: TFile) {
        const empty = container.createDiv({
            cls: 'text-center p-5 text-[var(--text-muted)]',
        });

        empty.createDiv({
            text: 'No similar notes found.',
        });

        const btn = empty.createEl('button', {
            text: 'Analyze this note',
            cls: 'mt-2 px-4 py-2 bg-[var(--interactive-accent)] text-[var(--text-on-accent)] border-none rounded-[4px] cursor-pointer font-medium hover:bg-[var(--interactive-accent-hover)] transition-colors',
        });

        btn.onclick = async () => {
            await this.plugin.indexingService.indexFile(file, true);
        };
    }

    private renderItem(container: HTMLElement, result: SemanticSearchResult) {
        const item = container.createDiv({
            cls: 'mb-2 cursor-grab active:cursor-grabbing',
        });

        const title = getTitleFromPath(result.path);

        const toggle = this.renderHeader(
            item,
            title,
            result.path,
            result.similarity,
        );
        this.renderPreview(item, toggle, result.path);

        enableDrag(item, title);
    }

    private renderHeader(
        container: HTMLElement,
        title: string,
        path: string,
        similarity: number,
    ): HTMLElement {
        const header = container.createDiv({
            cls: 'flex items-center gap-2 rounded-[4px] cursor-pointer transition-[background-color] duration-100 ease-in-out hover:bg-[var(--background-modifier-hover)] active:bg-[var(--background-modifier-active)]',
        });

        const toggle = header.createDiv({
            cls: 'flex items-center justify-center w-6 h-6 shrink-0 text-[var(--text-muted)] transition-transform duration-100 cursor-pointer rounded-[4px] hover:bg-[var(--background-modifier-hover)] hover:text-[var(--text-normal)]',
        });
        setIcon(toggle, 'chevron-right');

        const titleEl = header.createDiv({
            text: title,
            cls: 'flex-grow truncate text-[var(--text-normal)] text-sm',
        });
        titleEl.setAttr('title', path);

        header.createDiv({
            text: formatPercent(similarity),
            cls: 'shrink-0 text-xs text-[var(--text-muted)] bg-[var(--background-primary-alt)] px-2 py-0.5 rounded-[4px]',
        });

        header.onclick = (e) => this.openFile(path, e);

        return toggle;
    }

    private renderPreview(
        container: HTMLElement,
        toggleBtn: HTMLElement,
        path: string,
    ) {
        const preview = container.createDiv({
            cls: 'ml-6 mt-1 mb-2 p-3 bg-[var(--background-primary)] border border-[var(--background-modifier-border)] text-[var(--text-muted)] rounded-[4px] text-xs leading-relaxed whitespace-pre-wrap break-words opacity-0 -translate-y-1 transition-[opacity,transform] duration-200 pointer-events-none hidden',
        });

        const state: PreviewState = {
            isOpen: false,
            element: preview,
            toggle: toggleBtn,
        };

        toggleBtn.onclick = async (e) => {
            e.stopPropagation();
            state.isOpen = !state.isOpen;

            if (state.isOpen && preview.innerText === '') {
                preview.setText('Loading...');
                try {
                    const text = await this.readFilePreview(path);
                    preview.setText(text);
                } catch {
                    preview.setText('Failed to load preview.');
                }
            }
            animatePreview(state);
        };
    }

    private async readFilePreview(path: string): Promise<string> {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return 'File not found.';

        const content = await this.plugin.app.vault.read(file);
        return cleanText(content, 'preview').slice(
            0,
            this.plugin.settings.previewLength,
        );
    }

    private openFile(path: string, evt: MouseEvent) {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;
        const { newLeaf, state } = createOpenState(evt);
        void this.plugin.app.workspace.getLeaf(newLeaf).openFile(file, state);
    }
}
