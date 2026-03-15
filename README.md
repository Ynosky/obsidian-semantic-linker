
# Obsidian Semantic Linker

Obsidian plugin for semantic search and discovering similar notes using the Google Gemini API.

> **Note**: This plugin is not published in the Community Plugins directory. Manual installation only.

## Features

- **Similar Notes**: Discover related notes in the sidebar or inline at the bottom of each note
- **Semantic Search**: Find notes by meaning, not just keywords
- **Auto-indexing**: Automatically re-indexes notes when files are created, modified, renamed, or deleted
- **Exclusion Rules**: Exclude notes by path pattern (gitignore syntax) or frontmatter tag

## Requirements

- A [Google AI Studio](https://aistudio.google.com/) API key with access to the Gemini embedding model
- Obsidian v0.23.0 or later
- Desktop only (not supported on mobile)

## Installation

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest)
2. Copy the files to `<vault>/.obsidian/plugins/semantic-linker/`
3. Enable the plugin in **Obsidian → Settings → Community plugins**

## Setup

1. Open **Settings → Semantic Linker**
2. Paste your Gemini API key in the **Gemini API key** field and click the ✓ button to verify it
3. (Optional) Adjust exclusion patterns, thresholds, and display settings
4. Run the command **"Semantic Linker: Index all files"** to build the initial index

## Usage

| Action | How to trigger |
|--------|---------------|
| Semantic search | Click the ✨ ribbon icon, or run **Semantic Linker: Semantic search** |
| Similar notes sidebar | Run **Semantic Linker: Show sidebar view** |
| Toggle inline similar notes | Run **Semantic Linker: Toggle inline view** |
| Index all files | Run **Semantic Linker: Index all files** |
| Re-index all files (force) | Run **Semantic Linker: Re-index all files** |
| Index current file | Run **Semantic Linker: Index current file** |
| Clear index | Run **Semantic Linker: Clear index** |
| Stop indexing | Run **Semantic Linker: Stop indexing** |

## Development

```bash
pnpm install
pnpm run dev        # Watch mode (JS only)
pnpm run build      # Production build (CSS + type-check + JS)
pnpm run lint       # Biome check
pnpm run format     # Biome format
```
