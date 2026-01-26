const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

const addVector = (
    sumVec: Float32Array,
    vec: readonly number[] | Float32Array,
    weight: number,
    dim: number,
): void => {
    for (let d = 0; d < dim; d++) {
        const currentSum = sumVec[d];
        const val = vec[d];

        if (currentSum !== undefined) {
            sumVec[d] = currentSum + (val ?? 0) * weight;
        }
    }
};

export const averageEmbeddings = async (
    embeddings: (readonly number[] | Float32Array)[],
    introWeight = 1.0,
): Promise<number[]> => {
    const numVec = embeddings.length;
    if (numVec === 0) return [];

    const firstVec = embeddings[0];
    if (!firstVec) return [];
    if (numVec === 1) return Array.from(firstVec);

    const dim = firstVec.length;
    const totalWeight = numVec - 1 + introWeight;
    const sumVec = new Float32Array(dim);

    for (let i = 0; i < numVec; i++) {
        if (i > 0 && i % 50 === 0) await yieldToMain();

        const vec = embeddings[i];
        if (!vec) continue;

        const weight = i === 0 ? introWeight : 1.0;
        addVector(sumVec, vec, weight, dim);
    }

    const result = new Array<number>(dim);
    for (let d = 0; d < dim; d++) {
        const finalSum = sumVec[d];
        if (finalSum !== undefined) {
            result[d] = finalSum / totalWeight;
        } else {
            result[d] = 0;
        }
    }

    return result;
};
