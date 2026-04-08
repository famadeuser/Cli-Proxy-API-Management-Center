import type { ModelPrice } from '@/utils/usage';

const HELICONE_LLM_COSTS_URL = 'https://www.helicone.ai/api/llm-costs';
const TOKENS_PER_PRICE_UNIT = 1_000_000;

export type SupportedPricingProvider = 'openai' | 'anthropic';

export interface ModelPriceFetchCandidate {
  model: string;
  provider: SupportedPricingProvider;
}

export interface HeliconeModelPriceMatch {
  model: string;
  provider: SupportedPricingProvider;
  pricePatch: Partial<ModelPrice>;
  matchedRecordModel: string;
}

export interface HeliconeModelPriceFetchResult {
  candidates: ModelPriceFetchCandidate[];
  matched: HeliconeModelPriceMatch[];
  unmatched: ModelPriceFetchCandidate[];
}

interface HeliconeCatalogRow {
  provider: SupportedPricingProvider;
  model: string;
  modelKey: string;
  operator: 'exact' | 'startswith' | 'includes';
  pricePatch: Partial<ModelPrice>;
}

const OPENAI_MODEL_HINT_REGEX =
  /(^|[/:._-])(gpt|o[1-9]\d*|text-embedding|whisper|tts|dall-e|babbage|davinci)([/:._-]|$)/i;
const ANTHROPIC_MODEL_HINT_REGEX = /(^|[/:._-])claude([/:._-]|$)/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toNonNegativeFinite = (value: unknown): number | undefined => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  return numeric;
};

const readFirstNumeric = (record: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = toNonNegativeFinite(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
};

const readCostPer1M = (
  record: Record<string, unknown>,
  perMillionKeys: string[],
  perTokenKeys: string[] = []
): number | undefined => {
  const perMillion = readFirstNumeric(record, perMillionKeys);
  if (perMillion !== undefined) {
    return perMillion;
  }

  const perToken = readFirstNumeric(record, perTokenKeys);
  if (perToken !== undefined) {
    return perToken * TOKENS_PER_PRICE_UNIT;
  }

  return undefined;
};

const normalizeProvider = (value: unknown): SupportedPricingProvider | null => {
  const provider = String(value ?? '').trim().toLowerCase();
  if (provider === 'openai') return 'openai';
  if (provider === 'anthropic') return 'anthropic';
  return null;
};

const normalizeModelKey = (value: string): string => {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (!trimmed) return '';

  let normalized = trimmed.replace(/^\/?models\//, '');
  normalized = normalized.replace(/^(openai|anthropic)[/:]/, '');
  normalized = normalized.replace(/\s+/g, '');
  return normalized;
};

const normalizeOperator = (value: unknown): HeliconeCatalogRow['operator'] => {
  const operator = String(value ?? '').trim().toLowerCase();
  if (operator === 'startswith') return 'startswith';
  if (operator === 'includes') return 'includes';
  return 'exact';
};

const extractCatalogRows = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
    if (Array.isArray(payload.rows)) {
      return payload.rows;
    }
    if (Array.isArray(payload.models)) {
      return payload.models;
    }
  }
  return [];
};

const normalizeCatalogRows = (payload: unknown): HeliconeCatalogRow[] => {
  const rows = extractCatalogRows(payload);
  const normalized: HeliconeCatalogRow[] = [];

  rows.forEach((row) => {
    if (!isRecord(row)) return;

    const provider = normalizeProvider(row.provider);
    const model = String(row.model ?? row.model_name ?? row.modelName ?? '').trim();
    if (!provider || !model) return;

    const prompt = readCostPer1M(
      row,
      ['input_cost_per_1m', 'inputCostPer1M', 'prompt_cost_per_1m', 'promptCostPer1M'],
      ['input_token_cost', 'inputTokenCost', 'input_cost', 'inputCost']
    );
    const completion = readCostPer1M(
      row,
      ['output_cost_per_1m', 'outputCostPer1M', 'completion_cost_per_1m', 'completionCostPer1M'],
      ['output_token_cost', 'outputTokenCost', 'output_cost', 'outputCost']
    );

    // Prefer cache-read semantics to align with the app's current single cache price model.
    const cacheRead = readCostPer1M(
      row,
      [
        'prompt_cache_read_cost_per_1m',
        'promptCacheReadCostPer1M',
        'cache_read_cost_per_1m',
        'cacheReadCostPer1M'
      ],
      ['cache_read_input_token_cost', 'cacheReadInputTokenCost', 'prompt_cache_read_cost']
    );
    const cacheFallback = readCostPer1M(
      row,
      ['cache_cost_per_1m', 'cacheCostPer1M'],
      ['cache_cost', 'cacheCost']
    );

    const pricePatch: Partial<ModelPrice> = {};
    if (prompt !== undefined) {
      pricePatch.prompt = prompt;
    }
    if (completion !== undefined) {
      pricePatch.completion = completion;
    }
    if (cacheRead !== undefined) {
      pricePatch.cache = cacheRead;
    } else if (cacheFallback !== undefined) {
      pricePatch.cache = cacheFallback;
    }

    if (pricePatch.prompt === undefined && pricePatch.completion === undefined && pricePatch.cache === undefined) {
      return;
    }

    normalized.push({
      provider,
      model,
      modelKey: normalizeModelKey(model),
      operator: normalizeOperator(row.operator),
      pricePatch
    });
  });

  return normalized;
};

const matchOperatorScore = (
  candidateKey: string,
  row: Pick<HeliconeCatalogRow, 'modelKey' | 'operator'>
): number => {
  if (!candidateKey || !row.modelKey) return -1;

  if (row.operator === 'startswith') {
    return candidateKey.startsWith(row.modelKey) ? 2000 + row.modelKey.length : -1;
  }

  if (row.operator === 'includes') {
    return candidateKey.includes(row.modelKey) ? 1000 + row.modelKey.length : -1;
  }

  return candidateKey === row.modelKey ? 3000 + row.modelKey.length : -1;
};

const findBestCatalogRow = (
  candidate: ModelPriceFetchCandidate,
  catalog: HeliconeCatalogRow[]
): HeliconeCatalogRow | null => {
  const candidateKey = normalizeModelKey(candidate.model);
  if (!candidateKey) return null;

  let best: HeliconeCatalogRow | null = null;
  let bestScore = -1;

  catalog.forEach((row) => {
    if (row.provider !== candidate.provider) return;

    const score = matchOperatorScore(candidateKey, row);
    if (score < 0) return;

    if (!best || score > bestScore || (score === bestScore && row.model.length > best.model.length)) {
      best = row;
      bestScore = score;
    }
  });

  return best;
};

export const inferPricingProviderFromModel = (modelName: string): SupportedPricingProvider | null => {
  const trimmed = String(modelName ?? '').trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('openai/') || lowered.startsWith('openai:')) {
    return 'openai';
  }
  if (lowered.startsWith('anthropic/') || lowered.startsWith('anthropic:')) {
    return 'anthropic';
  }

  if (ANTHROPIC_MODEL_HINT_REGEX.test(lowered)) {
    return 'anthropic';
  }
  if (OPENAI_MODEL_HINT_REGEX.test(lowered)) {
    return 'openai';
  }

  return null;
};

export const buildSupportedPricingCandidates = (models: string[]): ModelPriceFetchCandidate[] => {
  const unique = new Map<string, ModelPriceFetchCandidate>();

  models.forEach((model) => {
    const trimmed = model.trim();
    if (!trimmed) return;

    const provider = inferPricingProviderFromModel(trimmed);
    if (!provider) return;

    const uniqueKey = `${provider}:${trimmed.toLowerCase()}`;
    if (!unique.has(uniqueKey)) {
      unique.set(uniqueKey, { model: trimmed, provider });
    }
  });

  return Array.from(unique.values());
};

const dedupeCandidates = (candidates: ModelPriceFetchCandidate[]): ModelPriceFetchCandidate[] => {
  const unique = new Map<string, ModelPriceFetchCandidate>();

  candidates.forEach((candidate) => {
    const model = String(candidate.model ?? '').trim();
    if (!model) return;
    if (candidate.provider !== 'openai' && candidate.provider !== 'anthropic') return;

    const key = `${candidate.provider}:${model.toLowerCase()}`;
    if (!unique.has(key)) {
      unique.set(key, { model, provider: candidate.provider });
    }
  });

  return Array.from(unique.values());
};

export async function fetchHeliconeModelPrices(
  candidates: ModelPriceFetchCandidate[],
  signal?: AbortSignal
): Promise<HeliconeModelPriceFetchResult> {
  const uniqueCandidates = dedupeCandidates(candidates);
  if (!uniqueCandidates.length) {
    return {
      candidates: [],
      matched: [],
      unmatched: []
    };
  }

  const response = await fetch(HELICONE_LLM_COSTS_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    },
    signal
  });

  if (!response.ok) {
    throw new Error(`Helicone pricing request failed (${response.status})`);
  }

  const payload: unknown = await response.json();
  const catalog = normalizeCatalogRows(payload);

  const matched: HeliconeModelPriceMatch[] = [];
  const unmatched: ModelPriceFetchCandidate[] = [];

  uniqueCandidates.forEach((candidate) => {
    const row = findBestCatalogRow(candidate, catalog);
    if (!row) {
      unmatched.push(candidate);
      return;
    }

    matched.push({
      model: candidate.model,
      provider: candidate.provider,
      pricePatch: row.pricePatch,
      matchedRecordModel: row.model
    });
  });

  return {
    candidates: uniqueCandidates,
    matched,
    unmatched
  };
}
