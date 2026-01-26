export const formatPercent = (ratio: number, decimals = 1): string =>
    `${(ratio * 100).toFixed(decimals)}%`;

export const getTitleFromPath = (path: string): string =>
    (path.split('/').pop() || path).replace(/\.md$/, '');

export const getVaultHash = async (vaultPath: string): Promise<string> => {
    const msgUint8 = new TextEncoder().encode(vaultPath);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
};
