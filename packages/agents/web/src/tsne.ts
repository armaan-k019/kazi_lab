import { mulberry32 } from "./graph-algos";

// Barnes-Hut t-SNE over high-dimensional vectors to 3D. Deterministic and seeded
// (same seed + same input = same output), unit-tested for cluster separation and
// reproducibility. This is the projection behind the 3D web view. No LLM touches
// it. Follows van der Maaten's Barnes-Hut t-SNE (2014): exact attractive forces
// over the (sparse-enough here) affinity matrix P, tree-approximated repulsive
// forces with a space-partitioning octree gated by theta.

export type TsneParams = {
  dims: number; // 3 for the web
  perplexity: number; // scaled to corpus size by the caller
  learningRate: number;
  iterations: number;
  theta: number; // Barnes-Hut accuracy; 0.5 default, 0 = exact repulsion
  earlyExaggeration: number;
  seed: number;
};

// Documented defaults. Perplexity is scaled to corpus size by defaultTsneParams.
export const TSNE_DEFAULTS = {
  dims: 3,
  learningRate: 200,
  iterations: 500,
  theta: 0.5,
  earlyExaggeration: 12,
  seed: 1337,
  earlyExaggerationEnd: 250, // iterations with exaggeration + low momentum
};

// Perplexity is capped well under (N-1)/3 so the binary search is well-posed on
// small corpora (a t-SNE requirement).
export function defaultTsneParams(n: number, overrides?: Partial<TsneParams>): TsneParams {
  const perplexity = Math.max(2, Math.min(30, Math.floor((n - 1) / 3)));
  return {
    dims: TSNE_DEFAULTS.dims,
    perplexity,
    learningRate: TSNE_DEFAULTS.learningRate,
    iterations: TSNE_DEFAULTS.iterations,
    theta: TSNE_DEFAULTS.theta,
    earlyExaggeration: TSNE_DEFAULTS.earlyExaggeration,
    seed: TSNE_DEFAULTS.seed,
    ...overrides,
  };
}

function pairwiseSqDist(X: number[][]): Float64Array {
  const n = X.length;
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      const xi = X[i];
      const xj = X[j];
      for (let d = 0; d < xi.length; d++) {
        const diff = xi[d] - xj[d];
        s += diff * diff;
      }
      D[i * n + j] = s;
      D[j * n + i] = s;
    }
  }
  return D;
}

// High-dimensional affinities P via a per-point precision (beta) binary search to
// match the target perplexity, then symmetrized.
function computeP(X: number[][], perplexity: number): Float64Array {
  const n = X.length;
  const D = pairwiseSqDist(X);
  const P = new Float64Array(n * n);
  const logU = Math.log(perplexity);
  const tol = 1e-5;
  for (let i = 0; i < n; i++) {
    let beta = 1;
    let betamin = -Infinity;
    let betamax = Infinity;
    const row = new Float64Array(n);
    for (let iter = 0; iter < 50; iter++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const v = Math.exp(-D[i * n + j] * beta);
        row[j] = v;
        sum += v;
      }
      if (sum === 0) sum = 1e-12;
      let H = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        H += beta * D[i * n + j] * (row[j] / sum);
      }
      H = H + Math.log(sum);
      const diff = H - logU;
      if (Math.abs(diff) < tol) break;
      if (diff > 0) {
        betamin = beta;
        beta = betamax === Infinity ? beta * 2 : (beta + betamax) / 2;
      } else {
        betamax = beta;
        beta = betamin === -Infinity ? beta / 2 : (beta + betamin) / 2;
      }
    }
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      row[j] = Math.exp(-D[i * n + j] * beta);
      sum += row[j];
    }
    if (sum === 0) sum = 1e-12;
    for (let j = 0; j < n; j++) if (j !== i) P[i * n + j] = row[j] / sum;
  }
  // Symmetrize: (P + P^T) / (2N).
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out[i * n + j] = Math.max((P[i * n + j] + P[j * n + i]) / (2 * n), 1e-12);
    }
  }
  return out;
}

// A 3D space-partitioning tree (octree) for Barnes-Hut repulsive forces.
type SPNode = {
  cx: number; cy: number; cz: number; hw: number;
  cum: number;
  comX: number; comY: number; comZ: number;
  leaf: boolean;
  data: number; // point index if a leaf holds exactly one, else -1
  children: SPNode[] | null;
};
function makeNode(cx: number, cy: number, cz: number, hw: number): SPNode {
  return { cx, cy, cz, hw, cum: 0, comX: 0, comY: 0, comZ: 0, leaf: true, data: -1, children: null };
}
function octant(node: SPNode, x: number, y: number, z: number): number {
  return (x > node.cx ? 1 : 0) + (y > node.cy ? 2 : 0) + (z > node.cz ? 4 : 0);
}
function subdivide(node: SPNode): void {
  const h = node.hw / 2;
  node.children = [];
  for (let i = 0; i < 8; i++) {
    const dx = i & 1 ? h : -h;
    const dy = i & 2 ? h : -h;
    const dz = i & 4 ? h : -h;
    node.children.push(makeNode(node.cx + dx, node.cy + dy, node.cz + dz, h));
  }
  node.leaf = false;
}
function insert(node: SPNode, Y: number[][], idx: number): void {
  const x = Y[idx][0], y = Y[idx][1], z = Y[idx][2];
  node.comX = (node.comX * node.cum + x) / (node.cum + 1);
  node.comY = (node.comY * node.cum + y) / (node.cum + 1);
  node.comZ = (node.comZ * node.cum + z) / (node.cum + 1);
  node.cum += 1;
  if (node.leaf && node.data === -1) {
    node.data = idx;
    return;
  }
  if (node.leaf && node.data !== -1) {
    const old = node.data;
    node.data = -1;
    subdivide(node);
    const oc = octant(node, Y[old][0], Y[old][1], Y[old][2]);
    insert(node.children![oc], Y, old);
  }
  if (!node.children) subdivide(node);
  insert(node.children![octant(node, x, y, z)], Y, idx);
}
// Accumulate the repulsive (non-edge) force on point idx, plus its Q normalizer.
function computeNonEdge(node: SPNode, idx: number, Y: number[][], theta2: number, negF: Float64Array, sumQ: { v: number }): void {
  if (node.cum === 0 || (node.leaf && node.data === idx)) return;
  const dx = Y[idx][0] - node.comX;
  const dy = Y[idx][1] - node.comY;
  const dz = Y[idx][2] - node.comZ;
  const d2 = dx * dx + dy * dy + dz * dz;
  const width = 2 * node.hw;
  if (node.leaf || width * width < theta2 * d2) {
    const q = 1 / (1 + d2);
    let mult = node.cum * q;
    sumQ.v += mult;
    mult *= q;
    negF[0] += mult * dx;
    negF[1] += mult * dy;
    negF[2] += mult * dz;
    return;
  }
  for (const c of node.children!) computeNonEdge(c, idx, Y, theta2, negF, sumQ);
}

// Run Barnes-Hut t-SNE. Returns an N x dims array of coordinates.
export function tsne(X: number[][], paramsIn?: Partial<TsneParams>): number[][] {
  const n = X.length;
  const params = defaultTsneParams(n, paramsIn);
  const dims = params.dims;
  const rand = mulberry32(params.seed);
  if (n === 0) return [];
  if (n === 1) return [new Array(dims).fill(0)];

  const P = computeP(X, params.perplexity);
  // Seeded small-gaussian init.
  const Y: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let d = 0; d < dims; d++) row.push((rand() - 0.5) * 1e-4);
    Y.push(row);
  }
  const uY: number[][] = Y.map(() => new Array(dims).fill(0));
  const gains: number[][] = Y.map(() => new Array(dims).fill(1));
  const theta2 = params.theta * params.theta;
  const exaggeration = params.earlyExaggeration;

  for (let iter = 0; iter < params.iterations; iter++) {
    const early = iter < TSNE_DEFAULTS.earlyExaggerationEnd;
    const momentum = early ? 0.5 : 0.8;
    const exag = early ? exaggeration : 1;

    // Build the tree for repulsive forces (exact when theta = 0).
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of Y) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const hw = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6) / 2 + 1e-6;
    const root = makeNode(cx, cy, cz, hw);
    for (let i = 0; i < n; i++) insert(root, Y, i);

    // Attractive forces (exact over P) minus repulsive (tree), then update.
    const grad: number[][] = [];
    const sumQ = { v: 0 };
    const negFs: Float64Array[] = [];
    for (let i = 0; i < n; i++) {
      const negF = new Float64Array(3);
      computeNonEdge(root, i, Y, theta2, negF, sumQ);
      negFs.push(negF);
    }
    for (let i = 0; i < n; i++) {
      const posF = [0, 0, 0];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        let d2 = 0;
        for (let d = 0; d < dims; d++) {
          const df = Y[i][d] - Y[j][d];
          d2 += df * df;
        }
        const q = 1 / (1 + d2);
        const mult = exag * P[i * n + j] * q;
        for (let d = 0; d < dims; d++) posF[d] += mult * (Y[i][d] - Y[j][d]);
      }
      const g = [0, 0, 0];
      for (let d = 0; d < dims; d++) g[d] = posF[d] - negFs[i][d] / (sumQ.v || 1e-12);
      grad.push(g);
    }
    // Gains + momentum update.
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < dims; d++) {
        const gd = grad[i][d];
        gains[i][d] = Math.sign(gd) !== Math.sign(uY[i][d]) ? gains[i][d] + 0.2 : gains[i][d] * 0.8;
        if (gains[i][d] < 0.01) gains[i][d] = 0.01;
        uY[i][d] = momentum * uY[i][d] - params.learningRate * gains[i][d] * gd;
        Y[i][d] += uY[i][d];
      }
    }
    // Recenter to keep the cloud around the origin.
    const mean = new Array(dims).fill(0);
    for (const p of Y) for (let d = 0; d < dims; d++) mean[d] += p[d] / n;
    for (const p of Y) for (let d = 0; d < dims; d++) p[d] -= mean[d];
  }
  return Y;
}
