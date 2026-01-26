import type MainPlugin from 'main';
import { AbstractInputSuggest, type App } from 'obsidian';

export class TagSuggest extends AbstractInputSuggest<string> {
    constructor(
        app: App,
        private inputEl: HTMLInputElement,
        private plugin: MainPlugin,
    ) {
        super(app, inputEl);
    }

    getSuggestions(inputStr: string): string[] {
        const cursorPosition = this.inputEl.selectionStart || 0;
        const textBeforeCursor = inputStr.substring(0, cursorPosition);

        const parts = textBeforeCursor.split(/[,\s]+/);
        const lastPartRaw = parts[parts.length - 1] ?? '';
        const lastPart = lastPartRaw.replace(/^#/, '').toLowerCase();

        const tags = Array.from(this.plugin.tagManager.getGlobalTags());

        return tags
            .filter((tag) => tag.toLowerCase().contains(lastPart))
            .sort();
    }

    renderSuggestion(tag: string, el: HTMLElement): void {
        el.setText(`#${tag}`);
    }

    selectSuggestion(tag: string): void {
        const fullValue = this.inputEl.value;
        const cursorPosition = this.inputEl.selectionStart || 0;

        const textBeforeCursor = fullValue.substring(0, cursorPosition);
        const textAfterCursor = fullValue.substring(cursorPosition);

        const parts = textBeforeCursor.split(/([,\s]+)/);
        if (parts.length > 0) {
            parts[parts.length - 1] = tag;
        } else {
            parts.push(tag);
        }

        const newValue = parts.join('') + textAfterCursor;

        this.inputEl.value = newValue;
        this.inputEl.trigger('input');

        this.close();
    }
}
