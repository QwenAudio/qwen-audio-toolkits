import { useEffect, useMemo, useState } from 'react'
import {
  Boxes,
  CirclePlus,
  Download,
  HardDrive,
  KeyRound,
  PackageCheck,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
} from 'lucide-react'
import { cloudModelsFromCatalog } from '../cloudModels'
import {
  getModelBinding,
  recommendedDependencies,
  referencingModels,
} from '../modelDependencies'
import {
  MODEL_PRIMARY_CATEGORIES,
  modelTaxonomy,
  type ModelPrimaryCategory,
} from '../domain/modelTaxonomy'
import {
  installLocalModelAndRefresh,
  refreshThenPersistCloudModelState,
} from '../services/extensionModelStoreLifecycle'
import { getLocale, t, useLocale } from '../i18n'
import type {
  ApiModelCatalogEntry,
  CustomApiModelDefinition,
  HarnessCatalog,
  ModelDependencyBindings,
  ModelPlugin,
  RuntimeStatus,
} from '../types'
import './ExtensionModelStoreView.css'

export interface ModelStoreRemoval {
  retained: boolean
  referencedBy: string[]
}

export interface ExtensionModelStoreViewProps {
  /** Kept explicit so the workbench can never become the boss Agent catalog. */
  catalogKind?: 'models'
  plugins: ModelPlugin[]
  modelBindings: ModelDependencyBindings
  runtime: RuntimeStatus
  catalog: HarnessCatalog | null
  apiModelCatalog: ApiModelCatalogEntry[]
  customApiModels: CustomApiModelDefinition[]
  installedCloudModelIds: string[]
  onConfigureProvider(providerId: string): void
  onRefreshModels(): Promise<void>
  onInstallModel(pluginId: string, variantId?: string): Promise<ModelPlugin>
  onInstallModelDependency(dependencyId: string): Promise<void>
  onRestoreModel(pluginId: string): Promise<void>
  onUninstallModel(pluginId: string): Promise<ModelStoreRemoval>
  onSetModelBinding(
    pluginId: string,
    role: string,
    dependencyId: string,
  ): Promise<void>
  onCloudModelInstalled(modelId: string, installed: boolean): void
  onAction(message: string): void
}

function isApiPlugin(plugin: ModelPlugin): boolean {
  return (
    plugin.providerId?.startsWith('api.') === true ||
    /api|cloud|remote/i.test(plugin.runtime)
  )
}

function displayVersion(plugin: ModelPlugin, apiPlugin: boolean): string {
  const version = plugin.version.trim()
  return apiPlugin || !version || version.startsWith('v') || !/^\d/.test(version)
    ? version
    : `v${version}`
}

function secondaryLabel(id: string): string {
  const modalityLabels: Record<string, string> = {
    Audio: '语音',
    Text: '文本',
    Vision: '图像',
  }
  const [from, to] = id.split('-to-')
  const side = (part?: string) =>
    part
      ?.split('-')
      .map((modality) => t(modalityLabels[modality] ?? modality))
      .join('+')
  return `${side(from)} → ${side(to)}`
}

export function ExtensionModelStoreView({
  catalogKind = 'models',
  plugins,
  modelBindings,
  runtime,
  catalog,
  apiModelCatalog,
  customApiModels,
  installedCloudModelIds,
  onConfigureProvider,
  onRefreshModels,
  onInstallModel,
  onInstallModelDependency,
  onRestoreModel,
  onUninstallModel,
  onSetModelBinding,
  onCloudModelInstalled,
  onAction,
}: ExtensionModelStoreViewProps) {
  const locale = useLocale()
  const [search, setSearch] = useState('')
  const [installedOnly, setInstalledOnly] = useState(false)
  const [primaryFilter, setPrimaryFilter] = useState<
    'all' | ModelPrimaryCategory
  >('all')
  const [secondaryFilter, setSecondaryFilter] = useState('all')
  const [runtimeFilter, setRuntimeFilter] = useState<'all' | 'offline' | 'api'>(
    'all',
  )
  const [selectedId, setSelectedId] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>(
    {},
  )

  const cloudModels = useMemo(
    () =>
      cloudModelsFromCatalog(
        catalog,
        installedCloudModelIds,
        apiModelCatalog,
        customApiModels,
      ),
    [apiModelCatalog, catalog, customApiModels, installedCloudModelIds],
  )
  const allModels = useMemo(
    () =>
      [...plugins, ...cloudModels]
        .filter((model) => model.extensionKind !== 'workspace-agent')
        .sort((left, right) =>
          left.name.localeCompare(right.name, getLocale(), {
            numeric: true,
            sensitivity: 'base',
          }),
        ),
    [cloudModels, plugins, locale],
  )
  const taxonomyByModelId = useMemo(
    () => new Map(allModels.map((model) => [model.id, modelTaxonomy(model)])),
    [allModels],
  )
  const categoryTree = useMemo(
    () =>
      MODEL_PRIMARY_CATEGORIES.filter((category) => category.id !== 'agents').map(
        (category) => ({
          ...category,
          count: allModels.filter(
            (model) =>
              taxonomyByModelId.get(model.id)?.primaryCategory === category.id,
          ).length,
        }),
      ),
    [allModels, taxonomyByModelId],
  )
  const availableSecondary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const model of allModels) {
      const taxonomy = taxonomyByModelId.get(model.id)
      if (!taxonomy || (primaryFilter !== 'all' && taxonomy.primaryCategory !== primaryFilter)) {
        continue
      }
      counts.set(
        taxonomy.secondaryCategory,
        (counts.get(taxonomy.secondaryCategory) ?? 0) + 1,
      )
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((left, right) => left.id.localeCompare(right.id, locale))
  }, [allModels, locale, primaryFilter, taxonomyByModelId])

  useEffect(() => {
    if (
      secondaryFilter !== 'all' &&
      !availableSecondary.some((item) => item.id === secondaryFilter)
    ) {
      setSecondaryFilter('all')
    }
  }, [availableSecondary, secondaryFilter])

  useEffect(() => {
    if (!pendingDeleteId) return undefined
    const timer = window.setTimeout(() => setPendingDeleteId(null), 3200)
    return () => window.clearTimeout(timer)
  }, [pendingDeleteId])

  const filteredModels = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return allModels.filter((model) => {
      const taxonomy = taxonomyByModelId.get(model.id)
      const searchable = [
        model.id,
        model.name,
        model.description,
        model.author,
        model.version,
        model.runtime,
        ...model.capabilities,
        ...model.harnessCapabilities,
        ...(model.apiAliases ?? []),
        taxonomy?.primaryCategory,
        taxonomy?.secondaryCategory,
      ]
        .join(' ')
        .toLowerCase()
      const api = isApiPlugin(model)
      return (
        terms.every((term) => searchable.includes(term)) &&
        (primaryFilter === 'all' || taxonomy?.primaryCategory === primaryFilter) &&
        (secondaryFilter === 'all' || taxonomy?.secondaryCategory === secondaryFilter) &&
        (runtimeFilter === 'all' ||
          (runtimeFilter === 'api' && api) ||
          (runtimeFilter === 'offline' && !api)) &&
        (!installedOnly || model.installed)
      )
    })
  }, [
    allModels,
    installedOnly,
    primaryFilter,
    runtimeFilter,
    search,
    secondaryFilter,
    taxonomyByModelId,
  ])
  const selectedModel =
    filteredModels.find((model) => model.id === selectedId) ?? filteredModels[0]
  const selectedApiModel = selectedModel ? isApiPlugin(selectedModel) : false
  const selectedVariant = selectedModel?.variants?.find(
    (variant) =>
      variant.id ===
      (selectedVariants[selectedModel.id] ??
        selectedModel.selectedVariantId ??
        selectedModel.defaultVariantId),
  )
  const hasActiveFilters = Boolean(
    search.trim() ||
      installedOnly ||
      primaryFilter !== 'all' ||
      secondaryFilter !== 'all' ||
      runtimeFilter !== 'all',
  )

  useEffect(() => {
    if (!filteredModels.length) {
      if (selectedId) setSelectedId('')
      return
    }
    if (!filteredModels.some((model) => model.id === selectedId)) {
      setSelectedId(filteredModels[0].id)
    }
  }, [filteredModels, selectedId])

  const ensureDependencies = async (model: ModelPlugin) => {
    const optionalFailures: string[] = []
    for (const dependency of recommendedDependencies(model)) {
      const dependencyId = getModelBinding(
        modelBindings,
        model.id,
        dependency.role,
        dependency.default ? dependency.pluginId : '',
        allModels,
      )
      if (
        dependencyId &&
        !allModels.some(
          (candidate) => candidate.id === dependencyId && candidate.installed,
        )
      ) {
        try {
          await onInstallModelDependency(dependencyId)
        } catch (error) {
          if (!dependency.optional) throw error
          optionalFailures.push(dependency.label)
        }
      }
    }
    return optionalFailures
  }
  const optionalDependencyNotice = (failures: readonly string[]) =>
    failures.length
      ? t('；可选组件“{0}”未安装，不影响模型运行', [
          [...new Set(failures)].join('、'),
        ])
      : ''
  const variantIdFor = (model: ModelPlugin) =>
    selectedVariants[model.id] ??
    model.selectedVariantId ??
    model.defaultVariantId
  const installOrRestoreModel = async (model: ModelPlugin) => {
    if (busyId) return
    setBusyId(model.id)
    try {
      if (!model.installed) {
        const result = await installLocalModelAndRefresh({
          installModel: () => onInstallModel(model.id, variantIdFor(model)),
          installDependencies: ensureDependencies,
          refreshModels: onRefreshModels,
        })
        if (result.status === 'dependency-failed') {
          onAction(
            t('{0} 已安装，但配套组件安装失败：{1}', [
              result.installed.name,
              result.error instanceof Error
                ? result.error.message
                : String(result.error),
            ]),
          )
          return
        }
        setSelectedId(result.installed.id)
        onAction(
          t('{0} 已安装并注册到 Harness{1}', [
            result.installed.name,
            optionalDependencyNotice(result.optionalFailures),
          ]),
        )
      } else if (model.sidebarVisible === false) {
        const optionalFailures = await ensureDependencies(model)
        await onRestoreModel(model.id)
        await onRefreshModels()
        onAction(
          t('{0} 已添加到工作台{1}', [
            model.name,
            optionalDependencyNotice(optionalFailures),
          ]),
        )
      }
    } catch (error) {
      onAction(
        t('安装失败：{0}', [
          error instanceof Error ? error.message : String(error),
        ]),
      )
    } finally {
      setBusyId(null)
    }
  }
  const setCloudModelInstalled = async (model: ModelPlugin, installed: boolean) => {
    if (busyId) return
    setBusyId(model.id)
    try {
      const optionalFailures = installed ? await ensureDependencies(model) : []
      await refreshThenPersistCloudModelState({
        refreshModels: onRefreshModels,
        persistCloudState: () => onCloudModelInstalled(model.id, installed),
      })
      onAction(
        installed
          ? t('{0} 已添加到工作台{1}', [
              model.name,
              optionalDependencyNotice(optionalFailures),
            ])
          : t('{0} 已从工作台移除', [model.name]),
      )
    } catch (error) {
      onAction(
        t('操作失败：{0}', [
          error instanceof Error ? error.message : String(error),
        ]),
      )
    } finally {
      setBusyId(null)
    }
  }
  const removeModel = async (model: ModelPlugin) => {
    if (busyId || model.adapter === 'web-audio') return
    if (pendingDeleteId !== model.id) {
      setPendingDeleteId(model.id)
      onAction(t('再次点击删除 {0}', [model.name]))
      return
    }
    setPendingDeleteId(null)
    if (isApiPlugin(model)) {
      await setCloudModelInstalled(model, false)
      return
    }
    setBusyId(model.id)
    try {
      const removal = await onUninstallModel(model.id)
      onAction(
        removal.retained
          ? t('{0} 已隐藏；共享权重仍被 {1} 个模型引用', [
              model.name,
              removal.referencedBy.length,
            ])
          : t('{0} 的模型权重已从本机删除', [model.name]),
      )
    } catch (error) {
      onAction(
        t('删除失败：{0}', [
          error instanceof Error ? error.message : String(error),
        ]),
      )
    } finally {
      setBusyId(null)
    }
  }
  const resetFilters = () => {
    setSearch('')
    setInstalledOnly(false)
    setPrimaryFilter('all')
    setSecondaryFilter('all')
    setRuntimeFilter('all')
  }

  return (
    <section className="extension-model-store" data-catalog-kind={catalogKind}>
      <header className="extension-model-store__heading">
        <div>
          <h2>{t('模型与运行环境')}</h2>
          <p>{t('识别、合成、降噪、声纹和云端 API，组成技能可调用的基础能力。')}</p>
        </div>
        <span className="extension-model-store__count" role="status">
          {t('{0} / {1} 个模型', [filteredModels.length, allModels.length])}
        </span>
      </header>

      <div className="extension-model-store__layout">
        <main className="extension-model-store__catalog">
          <div className="extension-model-store__search" role="search">
            <Search size={15} />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('搜索模型、能力或作者')}
              aria-label={t('搜索模型')}
            />
          </div>
          <div className="extension-model-store__filters" aria-label={t('模型筛选')}>
            <div>
              <span>{t('类型')}</span>
              <button
                className={primaryFilter === 'all' ? 'active' : ''}
                type="button"
                onClick={() => setPrimaryFilter('all')}
              >
                {t('全部')}
              </button>
              {categoryTree.map((category) => (
                <button
                  className={primaryFilter === category.id ? 'active' : ''}
                  type="button"
                  key={category.id}
                  onClick={() => setPrimaryFilter(category.id)}
                >
                  {t(category.label)} ({category.count})
                </button>
              ))}
            </div>
            {availableSecondary.length > 0 && (
              <div>
                <span>{t('方向')}</span>
                <button
                  className={secondaryFilter === 'all' ? 'active' : ''}
                  type="button"
                  onClick={() => setSecondaryFilter('all')}
                >
                  {t('全部')}
                </button>
                {availableSecondary.map((secondary) => (
                  <button
                    className={secondaryFilter === secondary.id ? 'active' : ''}
                    type="button"
                    key={secondary.id}
                    onClick={() => setSecondaryFilter(secondary.id)}
                  >
                    {secondaryLabel(secondary.id)} ({secondary.count})
                  </button>
                ))}
              </div>
            )}
            <div>
              <span>{t('运行方式')}</span>
              <button
                className={runtimeFilter === 'all' ? 'active' : ''}
                type="button"
                onClick={() => setRuntimeFilter('all')}
              >
                {t('全部')}
              </button>
              <button
                className={runtimeFilter === 'offline' ? 'active' : ''}
                type="button"
                onClick={() => setRuntimeFilter('offline')}
              >
                <HardDrive size={12} /> {t('离线')}
              </button>
              <button
                className={runtimeFilter === 'api' ? 'active' : ''}
                type="button"
                onClick={() => setRuntimeFilter('api')}
              >
                <Wifi size={12} /> {t('云端 API')}
              </button>
            </div>
          </div>
          <div className="extension-model-store__toolbar">
            <button
              className={installedOnly ? 'active' : ''}
              type="button"
              aria-pressed={installedOnly}
              onClick={() => setInstalledOnly((current) => !current)}
            >
              <PackageCheck size={13} /> {t('已安装')}
            </button>
            {hasActiveFilters && (
              <button type="button" onClick={resetFilters}>
                {t('清除筛选')}
              </button>
            )}
          </div>
          <div className="extension-model-store__list">
            {!filteredModels.length && (
              <div className="extension-model-store__empty">
                <Boxes size={22} />
                <strong>
                  {hasActiveFilters ? t('没有符合条件的结果') : t('这个分类暂时没有模型')}
                </strong>
                <p>{t('尝试切换分类或搜索其他能力。')}</p>
              </div>
            )}
            {filteredModels.map((model) => {
              const apiModel = isApiPlugin(model)
              const requiresConfig = apiModel && !model.enabled
              const references = apiModel
                ? []
                : referencingModels(model.id, allModels, modelBindings)
              const retained =
                model.installed && model.sidebarVisible === false && references.length > 0
              return (
                <article
                  className={`extension-model-store__model${model.id === selectedModel?.id ? ' selected' : ''}`}
                  key={model.id}
                  onClick={() => setSelectedId(model.id)}
                >
                  <span className="extension-model-store__icon"><Boxes size={18} /></span>
                  <div className="extension-model-store__model-copy">
                    <div>
                      <h3>{model.name}</h3>
                      <span>{model.author} · {displayVersion(model, apiModel)}</span>
                    </div>
                    <p>{t(model.description)}</p>
                    <div className="extension-model-store__badges">
                      <span>{apiModel ? <Wifi size={11} /> : <HardDrive size={11} />}{apiModel ? t('云端 API') : t('离线运行')}</span>
                      {model.capabilities.map((capability) => <span key={capability}>{t(capability)}</span>)}
                    </div>
                  </div>
                  <div className="extension-model-store__actions">
                    {requiresConfig ? (
                      <button type="button" onClick={(event) => { event.stopPropagation(); onConfigureProvider(model.providerId ?? '') }}>
                        <KeyRound size={14} /> {t('配置')}
                      </button>
                    ) : apiModel ? (
                      <button
                        className={model.installed ? 'danger' : ''}
                        type="button"
                        disabled={busyId === model.id}
                        onClick={(event) => { event.stopPropagation(); void (model.installed ? removeModel(model) : setCloudModelInstalled(model, true)) }}
                      >
                        {busyId === model.id ? <RefreshCw className="model-spin" size={14} /> : model.installed ? <Trash2 size={14} /> : <CirclePlus size={14} />}
                        {model.installed ? (pendingDeleteId === model.id ? t('确认') : t('删除')) : t('添加')}
                      </button>
                    ) : model.installed && model.sidebarVisible !== false ? (
                      <button
                        className="danger"
                        type="button"
                        disabled={busyId === model.id || retained}
                        onClick={(event) => { event.stopPropagation(); void removeModel(model) }}
                      >
                        {busyId === model.id ? <RefreshCw className="model-spin" size={14} /> : retained ? <PackageCheck size={14} /> : <Trash2 size={14} />}
                        {retained ? t('依赖中') : pendingDeleteId === model.id ? t('确认') : t('删除')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === model.id || model.installable === false}
                        onClick={(event) => { event.stopPropagation(); void installOrRestoreModel(model) }}
                      >
                        {busyId === model.id ? <RefreshCw className="model-spin" size={14} /> : <Download size={14} />}
                        {model.installed ? t('添加') : model.installable === false ? t('适配中') : t('安装')}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        </main>

        <aside className="extension-model-store__details">
          {!selectedModel ? (
            <div className="extension-model-store__empty">
              <Boxes size={22} />
              <strong>{t('选择一个模型查看详情')}</strong>
              <p>{t('选择一个模型，查看能力、运行资源与安装选项。')}</p>
            </div>
          ) : (
            <>
              <header>
                <span>{selectedModel.author}</span>
                <h3>{selectedModel.name}</h3>
                <p>{t(selectedModel.description)}</p>
                <div className="extension-model-store__badges">
                  <span>{selectedApiModel ? t('云端 API') : t('离线运行')}</span>
                  <span>{displayVersion(selectedModel, selectedApiModel)}</span>
                  {!selectedApiModel && <span>{selectedVariant?.size ?? selectedModel.size}</span>}
                </div>
              </header>
              {!selectedApiModel && !selectedModel.installed && selectedModel.variants?.length ? (
                <label className="extension-model-store__variant">
                  <span>{t('模型精度')}</span>
                  <select
                    value={variantIdFor(selectedModel)}
                    disabled={busyId !== null}
                    onChange={(event) => setSelectedVariants((current) => ({ ...current, [selectedModel.id]: event.target.value }))}
                  >
                    {selectedModel.variants.map((variant) => (
                      <option key={variant.id} value={variant.id}>{variant.precision} · {variant.name} · {variant.size}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <section className="extension-model-store__runtime">
                <h4>{t('运行环境')}</h4>
                <dl>
                  <div><dt>{selectedApiModel ? t('服务商') : t('运行环境')}</dt><dd>{selectedApiModel ? selectedModel.author : selectedModel.runtime}</dd></div>
                  <div><dt>{selectedApiModel ? t('模型 ID') : t('模型大小')}</dt><dd>{selectedApiModel ? selectedModel.version : selectedVariant?.size ?? selectedModel.size}</dd></div>
                  <div><dt>{t('设备')}</dt><dd>{selectedApiModel ? t('云端执行') : runtime.device}</dd></div>
                  {!selectedApiModel && <div><dt>{t('加速')}</dt><dd>{selectedModel.acceleration.join(' / ')}</dd></div>}
                </dl>
              </section>
              {recommendedDependencies(selectedModel).length > 0 && (
                <section className="extension-model-store__dependencies">
                  <h4>{t('配套组件')}</h4>
                  {recommendedDependencies(selectedModel).map((dependency) => {
                    const candidates = allModels.filter(
                      (candidate) =>
                        candidate.installed &&
                        candidate.harnessCapabilities.includes(dependency.capability),
                    )
                    const binding = getModelBinding(
                      modelBindings,
                      selectedModel.id,
                      dependency.role,
                      dependency.default ? dependency.pluginId : '',
                      allModels,
                    )
                    return (
                      <label key={dependency.role}>
                        <span>{dependency.label}</span>
                        <select
                          value={binding}
                          onChange={(event) => {
                            const dependencyId = event.target.value
                            void onSetModelBinding(
                              selectedModel.id,
                              dependency.role,
                              dependencyId,
                            ).catch((error) => {
                              onAction(
                                t('无法保存配套组件：{0}', [
                                  error instanceof Error
                                    ? error.message
                                    : String(error),
                                ]),
                              )
                            })
                          }}
                        >
                          {dependency.optional && <option value="">{t('无')}</option>}
                          {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                          {!candidates.some((candidate) => candidate.id === dependency.pluginId) && <option value={dependency.pluginId}>{dependency.pluginId} {t('· 安装时尝试下载')}</option>}
                        </select>
                      </label>
                    )
                  })}
                </section>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  )
}
