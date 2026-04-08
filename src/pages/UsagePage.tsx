import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Select } from '@/components/ui/Select';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useThemeStore, useConfigStore, useNotificationStore } from '@/stores';
import {
  StatCards,
  UsageChart,
  ChartLineSelector,
  ApiDetailsCard,
  ModelStatsCard,
  PriceSettingsCard,
  CredentialStatsCard,
  RequestEventsDetailsCard,
  TokenBreakdownChart,
  CostTrendChart,
  ServiceHealthCard,
  useUsageData,
  useSparklines,
  useChartData
} from '@/components/usage';
import {
  getModelNamesFromUsage,
  getApiStats,
  getModelStats,
  filterUsageByFilters,
  buildUsageSourceFilterOptions,
  resolveUsageFilterWindow,
  normalizeUsageFilters,
  isUsageTimeRange,
  type UsageTimeRange,
  type UsageFilters
} from '@/utils/usage';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import {
  buildSupportedPricingCandidates,
  fetchHeliconeModelPrices
} from '@/services/heliconePricing';
import styles from './UsagePage.module.scss';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const CHART_LINES_STORAGE_KEY = 'cli-proxy-usage-chart-lines-v1';
const TIME_RANGE_STORAGE_KEY = 'cli-proxy-usage-time-range-v1';
const FILTERS_STORAGE_KEY = 'cli-proxy-usage-filters-v1';
const ALL_SOURCES_FILTER = '__all_sources__';
const DEFAULT_CHART_LINES = ['all'];
const DEFAULT_TIME_RANGE: UsageTimeRange = '24h';
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_HOURLY_WINDOW = 24 * 31;
const MAX_CHART_LINES = 9;
const TIME_RANGE_OPTIONS: ReadonlyArray<{ value: UsageTimeRange; labelKey: string }> = [
  { value: 'all', labelKey: 'usage_stats.range_all' },
  { value: '7h', labelKey: 'usage_stats.range_7h' },
  { value: '24h', labelKey: 'usage_stats.range_24h' },
  { value: '7d', labelKey: 'usage_stats.range_7d' },
  { value: '30d', labelKey: 'usage_stats.range_30d' },
  { value: 'custom', labelKey: 'usage_stats.range_custom' },
];
const HOUR_WINDOW_BY_TIME_RANGE: Record<Exclude<UsageTimeRange, 'all' | 'custom'>, number> = {
  '7h': 7,
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24
};

const toDateInputValue = (value: Date): string => {
  const year = value.getFullYear();
  const month = (value.getMonth() + 1).toString().padStart(2, '0');
  const day = value.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getDefaultCustomRange = () => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);

  return {
    customStartDate: toDateInputValue(start),
    customEndDate: toDateInputValue(end)
  };
};

const normalizeChartLines = (value: unknown, maxLines = MAX_CHART_LINES): string[] => {
  if (!Array.isArray(value)) {
    return DEFAULT_CHART_LINES;
  }

  const filtered = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxLines);

  return filtered.length ? filtered : DEFAULT_CHART_LINES;
};

const loadChartLines = (): string[] => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_CHART_LINES;
    }
    const raw = localStorage.getItem(CHART_LINES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_CHART_LINES;
    }
    return normalizeChartLines(JSON.parse(raw));
  } catch {
    return DEFAULT_CHART_LINES;
  }
};

const loadUsageFilters = (): UsageFilters => {
  try {
    if (typeof localStorage === 'undefined') {
      return { preset: DEFAULT_TIME_RANGE };
    }
    const rawFilters = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (rawFilters) {
      const parsed: unknown = JSON.parse(rawFilters);
      return normalizeUsageFilters(parsed, DEFAULT_TIME_RANGE);
    }

    const legacyPreset = localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    if (isUsageTimeRange(legacyPreset)) {
      return { preset: legacyPreset };
    }

    return { preset: DEFAULT_TIME_RANGE };
  } catch {
    return { preset: DEFAULT_TIME_RANGE };
  }
};

export function UsagePage() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isDark = resolvedTheme === 'dark';
  const config = useConfigStore((state) => state.config);

  // Data hook
  const {
    usage,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    setModelPrices,
    loadUsage,
    handleExport,
    handleImport,
    handleImportChange,
    importInputRef,
    exporting,
    importing
  } = useUsageData();

  useHeaderRefresh(loadUsage);

  // Chart lines state
  const [chartLines, setChartLines] = useState<string[]>(loadChartLines);
  const [usageFilters, setUsageFilters] = useState<UsageFilters>(loadUsageFilters);
  const [fetchingModelPrices, setFetchingModelPrices] = useState(false);

  const nowMs = useMemo(
    () => lastRefreshedAt?.getTime() ?? Date.now(),
    [lastRefreshedAt]
  );

  const timeRangeOptions = useMemo(
    () =>
      TIME_RANGE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: t(opt.labelKey)
      })),
    [t]
  );

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: config?.geminiApiKeys,
        claudeApiKeys: config?.claudeApiKeys,
        codexApiKeys: config?.codexApiKeys,
        vertexApiKeys: config?.vertexApiKeys,
        openaiCompatibility: config?.openaiCompatibility
      }),
    [
      config?.claudeApiKeys,
      config?.codexApiKeys,
      config?.geminiApiKeys,
      config?.openaiCompatibility,
      config?.vertexApiKeys
    ]
  );

  const timeFilteredUsage = useMemo(
    () =>
      usage
        ? filterUsageByFilters(
            usage,
            {
              ...usageFilters,
              sourceId: undefined
            },
            nowMs
          )
        : null,
    [nowMs, usage, usageFilters]
  );

  const sourceFilterOptions = useMemo(() => {
    const options = [
      {
        value: ALL_SOURCES_FILTER,
        label: t('usage_stats.filter_all_sources')
      }
    ];

    if (!timeFilteredUsage) {
      return options;
    }

    const derived = buildUsageSourceFilterOptions(timeFilteredUsage, sourceInfoMap);
    return [
      ...options,
      ...derived.map((item) => ({
        value: item.value,
        label: item.type ? `${item.label} (${item.type})` : item.label
      }))
    ];
  }, [sourceInfoMap, t, timeFilteredUsage]);

  const sourceFilterOptionSet = useMemo(
    () => new Set(sourceFilterOptions.map((option) => option.value)),
    [sourceFilterOptions]
  );
  const selectedSourceId =
    usageFilters.sourceId && sourceFilterOptionSet.has(usageFilters.sourceId)
      ? usageFilters.sourceId
      : ALL_SOURCES_FILTER;

  const filteredUsage = useMemo(
    () =>
      usage
        ? filterUsageByFilters(
            usage,
            {
              ...usageFilters,
              sourceId: selectedSourceId === ALL_SOURCES_FILTER ? undefined : selectedSourceId
            },
            nowMs
          )
        : null,
    [nowMs, selectedSourceId, usage, usageFilters]
  );

  const customRangeWindow = useMemo(
    () => resolveUsageFilterWindow(usageFilters, nowMs),
    [nowMs, usageFilters]
  );
  const hasCustomRangeInvalid =
    usageFilters.preset === 'custom' &&
    (customRangeWindow.startMs === null || customRangeWindow.endMs === null);

  const hourWindowHours = useMemo(() => {
    if (usageFilters.preset === 'all') {
      return undefined;
    }

    if (usageFilters.preset === 'custom') {
      const { startMs, endMs } = customRangeWindow;
      if (startMs === null || endMs === null) {
        return undefined;
      }

      const hours = Math.max(1, Math.ceil((endMs - startMs + 1) / ONE_HOUR_MS));
      return Math.min(hours, MAX_HOURLY_WINDOW);
    }

    return HOUR_WINDOW_BY_TIME_RANGE[usageFilters.preset];
  }, [customRangeWindow, usageFilters.preset]);

  const handleChartLinesChange = useCallback((lines: string[]) => {
    setChartLines(normalizeChartLines(lines));
  }, []);

  const handleTimePresetChange = useCallback((value: string) => {
    const preset = isUsageTimeRange(value) ? value : DEFAULT_TIME_RANGE;
    setUsageFilters((prev) => {
      if (preset !== 'custom') {
        return { ...prev, preset };
      }

      if (prev.customStartDate && prev.customEndDate) {
        return { ...prev, preset };
      }

      return {
        ...prev,
        ...getDefaultCustomRange(),
        preset
      };
    });
  }, []);

  const handleCustomStartDateChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.trim();
    setUsageFilters((prev) => ({
      ...prev,
      customStartDate: value || undefined
    }));
  }, []);

  const handleCustomEndDateChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.trim();
    setUsageFilters((prev) => ({
      ...prev,
      customEndDate: value || undefined
    }));
  }, []);

  const handleSourceFilterChange = useCallback((value: string) => {
    setUsageFilters((prev) => ({
      ...prev,
      sourceId: value === ALL_SOURCES_FILTER ? undefined : value
    }));
  }, []);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(CHART_LINES_STORAGE_KEY, JSON.stringify(chartLines));
    } catch {
      // Ignore storage errors.
    }
  }, [chartLines]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      const normalized = normalizeUsageFilters(usageFilters, DEFAULT_TIME_RANGE);
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(normalized));
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, normalized.preset);
    } catch {
      // Ignore storage errors.
    }
  }, [usageFilters]);

  useEffect(() => {
    if (!timeFilteredUsage) return;
    if (!usageFilters.sourceId) return;
    if (sourceFilterOptionSet.has(usageFilters.sourceId)) return;

    setUsageFilters((prev) => ({
      ...prev,
      sourceId: undefined
    }));
  }, [sourceFilterOptionSet, timeFilteredUsage, usageFilters.sourceId]);

  // Sparklines hook
  const {
    requestsSparkline,
    tokensSparkline,
    rpmSparkline,
    tpmSparkline,
    costSparkline
  } = useSparklines({ usage: filteredUsage, loading, nowMs });

  // Chart data hook
  const {
    requestsPeriod,
    setRequestsPeriod,
    tokensPeriod,
    setTokensPeriod,
    requestsChartData,
    tokensChartData,
    requestsChartOptions,
    tokensChartOptions
  } = useChartData({ usage: filteredUsage, chartLines, isDark, isMobile, hourWindowHours });

  // Derived data
  const modelNames = useMemo(() => getModelNamesFromUsage(filteredUsage), [filteredUsage]);
  const apiStats = useMemo(
    () => getApiStats(filteredUsage, modelPrices),
    [filteredUsage, modelPrices]
  );
  const modelStats = useMemo(
    () => getModelStats(filteredUsage, modelPrices),
    [filteredUsage, modelPrices]
  );
  const pricingCandidates = useMemo(
    () => buildSupportedPricingCandidates(modelStats.map((item) => item.model)),
    [modelStats]
  );
  const canFetchModelPrices = pricingCandidates.length > 0;

  const handleFetchModelPrices = useCallback(async () => {
    if (!canFetchModelPrices) {
      showNotification(t('usage_stats.model_price_fetch_no_supported_models'), 'info');
      return;
    }

    setFetchingModelPrices(true);
    try {
      const result = await fetchHeliconeModelPrices(pricingCandidates);

      if (!result.matched.length) {
        showNotification(
          t('usage_stats.model_price_fetch_no_matches', {
            total: result.candidates.length
          }),
          'warning'
        );
        return;
      }

      const nextPrices = { ...modelPrices };
      result.matched.forEach((match) => {
        const existing = nextPrices[match.model] ?? {
          prompt: 0,
          completion: 0,
          cache: 0
        };

        const prompt = match.pricePatch.prompt ?? existing.prompt ?? 0;
        const completion = match.pricePatch.completion ?? existing.completion ?? 0;
        const cache = match.pricePatch.cache ?? existing.cache ?? prompt;

        nextPrices[match.model] = { prompt, completion, cache };
      });

      setModelPrices(nextPrices);

      if (result.unmatched.length > 0) {
        showNotification(
          t('usage_stats.model_price_fetch_partial', {
            matched: result.matched.length,
            total: result.candidates.length
          }),
          'warning'
        );
      } else {
        showNotification(
          t('usage_stats.model_price_fetch_success', { count: result.matched.length }),
          'success'
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      showNotification(
        `${t('usage_stats.model_price_fetch_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setFetchingModelPrices(false);
    }
  }, [canFetchModelPrices, modelPrices, pricingCandidates, setModelPrices, showNotification, t]);

  const hasPrices = Object.keys(modelPrices).length > 0;

  return (
    <div className={styles.container}>
      {loading && !usage && (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} className={styles.loadingOverlaySpinner} />
            <span className={styles.loadingOverlayText}>{t('common.loading')}</span>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h1 className={styles.pageTitle}>{t('usage_stats.title')}</h1>
        <div className={styles.headerActions}>
          <div className={styles.timeRangeGroup}>
            <span className={styles.timeRangeLabel}>{t('usage_stats.range_filter')}</span>
            <Select
              value={usageFilters.preset}
              options={timeRangeOptions}
              onChange={handleTimePresetChange}
              className={styles.timeRangeSelectControl}
              ariaLabel={t('usage_stats.range_filter')}
              fullWidth={false}
            />
          </div>
          {usageFilters.preset === 'custom' && (
            <div className={styles.customDateGroup}>
              <label className={styles.timeRangeLabel} htmlFor="usage-custom-start">
                {t('usage_stats.custom_start_date')}
              </label>
              <input
                id="usage-custom-start"
                type="date"
                className={`input ${styles.customDateInput}`.trim()}
                value={usageFilters.customStartDate ?? ''}
                onChange={handleCustomStartDateChange}
              />
              <label className={styles.timeRangeLabel} htmlFor="usage-custom-end">
                {t('usage_stats.custom_end_date')}
              </label>
              <input
                id="usage-custom-end"
                type="date"
                className={`input ${styles.customDateInput}`.trim()}
                value={usageFilters.customEndDate ?? ''}
                onChange={handleCustomEndDateChange}
              />
            </div>
          )}
          <div className={styles.timeRangeGroup}>
            <span className={styles.timeRangeLabel}>{t('usage_stats.api_key_filter')}</span>
            <Select
              value={selectedSourceId}
              options={sourceFilterOptions}
              onChange={handleSourceFilterChange}
              className={styles.timeRangeSelectControl}
              ariaLabel={t('usage_stats.api_key_filter')}
              fullWidth={false}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleFetchModelPrices()}
            loading={fetchingModelPrices}
            disabled={!canFetchModelPrices || loading || exporting || importing}
          >
            {fetchingModelPrices
              ? t('usage_stats.model_price_fetch_loading')
              : t('usage_stats.model_price_fetch_action')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExport}
            loading={exporting}
            disabled={loading || importing}
          >
            {t('usage_stats.export')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleImport}
            loading={importing}
            disabled={loading || exporting}
          >
            {t('usage_stats.import')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadUsage().catch(() => {})}
            disabled={loading || exporting || importing}
          >
            {loading ? t('common.loading') : t('usage_stats.refresh')}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleImportChange}
          />
          {lastRefreshedAt && (
            <span className={styles.lastRefreshed}>
              {t('usage_stats.last_updated')}: {lastRefreshedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {hasCustomRangeInvalid && (
        <div className={styles.hint}>{t('usage_stats.custom_range_invalid')}</div>
      )}

      {error && <div className={styles.errorBox}>{error}</div>}

      {/* Stats Overview Cards */}
      <StatCards
        usage={filteredUsage}
        loading={loading}
        modelPrices={modelPrices}
        nowMs={nowMs}
        sparklines={{
          requests: requestsSparkline,
          tokens: tokensSparkline,
          rpm: rpmSparkline,
          tpm: tpmSparkline,
          cost: costSparkline
        }}
      />

      {/* Chart Line Selection */}
      <ChartLineSelector
        chartLines={chartLines}
        modelNames={modelNames}
        maxLines={MAX_CHART_LINES}
        onChange={handleChartLinesChange}
      />

      {/* Service Health */}
      <ServiceHealthCard usage={usage} loading={loading} />

      {/* Charts Grid */}
      <div className={styles.chartsGrid}>
        <UsageChart
          title={t('usage_stats.requests_trend')}
          period={requestsPeriod}
          onPeriodChange={setRequestsPeriod}
          chartData={requestsChartData}
          chartOptions={requestsChartOptions}
          loading={loading}
          isMobile={isMobile}
          emptyText={t('usage_stats.no_data')}
        />
        <UsageChart
          title={t('usage_stats.tokens_trend')}
          period={tokensPeriod}
          onPeriodChange={setTokensPeriod}
          chartData={tokensChartData}
          chartOptions={tokensChartOptions}
          loading={loading}
          isMobile={isMobile}
          emptyText={t('usage_stats.no_data')}
        />
      </div>

      {/* Token Breakdown Chart */}
      <TokenBreakdownChart
        usage={filteredUsage}
        loading={loading}
        isDark={isDark}
        isMobile={isMobile}
        hourWindowHours={hourWindowHours}
      />

      {/* Cost Trend Chart */}
      <CostTrendChart
        usage={filteredUsage}
        loading={loading}
        isDark={isDark}
        isMobile={isMobile}
        modelPrices={modelPrices}
        hourWindowHours={hourWindowHours}
      />

      {/* Details Grid */}
      <div className={styles.detailsGrid}>
        <ApiDetailsCard apiStats={apiStats} loading={loading} hasPrices={hasPrices} />
        <ModelStatsCard modelStats={modelStats} loading={loading} hasPrices={hasPrices} />
      </div>

      <RequestEventsDetailsCard
        usage={filteredUsage}
        loading={loading}
        geminiKeys={config?.geminiApiKeys || []}
        claudeConfigs={config?.claudeApiKeys || []}
        codexConfigs={config?.codexApiKeys || []}
        vertexConfigs={config?.vertexApiKeys || []}
        openaiProviders={config?.openaiCompatibility || []}
      />

      {/* Credential Stats */}
      <CredentialStatsCard
        usage={filteredUsage}
        loading={loading}
        geminiKeys={config?.geminiApiKeys || []}
        claudeConfigs={config?.claudeApiKeys || []}
        codexConfigs={config?.codexApiKeys || []}
        vertexConfigs={config?.vertexApiKeys || []}
        openaiProviders={config?.openaiCompatibility || []}
      />

      {/* Price Settings */}
      <PriceSettingsCard
        modelNames={modelNames}
        modelPrices={modelPrices}
        onPricesChange={setModelPrices}
      />
    </div>
  );
}
