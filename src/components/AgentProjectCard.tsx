import { t, useLocale } from "../i18n"
import type { AgentExtension } from '../types'

export function AgentProjectCard({ plugin }: { plugin: AgentExtension }) {
  const locale = useLocale()
  const separator = locale === 'en' ? ', ' : '、'

  const project = plugin.agent
  const harness = project?.harness
  const skillProject = plugin.extensionKind === 'workspace-agent'
  const harnessLabel = harness?.kind === 'app-workflow'
    ? `${t("应用工作流")} · ${harness.entry}`
    : harness?.adapter ?? plugin.adapter
  return (
    <section className="agent-project-card" aria-label={t("项目定义")}>
      <header>
        <strong>{skillProject ? t("内置技能") : project ? t("模型资源") : t("兼容扩展")}</strong>
        <span>{skillProject ? t("工作流") : project ? t("模型能力") : t("自定义协议")}</span>
      </header>
      <p>{t(project?.task ?? plugin.description)}</p>
      <dl>
        <div><dt>{skillProject ? t("技能入口") : t("模型 / API")}</dt><dd>{plugin.variants?.length
          ? plugin.variants.map((variant) => variant.name).join(' / ')
          : t(plugin.name)}</dd></div>
        <div><dt>Harness</dt><dd>{harnessLabel}</dd></div>
        <div><dt>{t("运行环境")}</dt><dd>{plugin.runtime}</dd></div>
        <div><dt>{t("输入")}</dt><dd>{plugin.inputs?.length
          ? plugin.inputs.map((port) => `${t(port.label || port.name)}${port.optional ? t("（可选）") : ''}`).join(separator)
          : t("由能力契约定义")}</dd></div>
        <div><dt>{t("输出")}</dt><dd>{plugin.outputs?.length
          ? plugin.outputs.map((port) => t(port.label || port.name)).join(separator)
          : plugin.capabilities.map((capability) => t(capability)).join(separator)}</dd></div>
      </dl>
      {project ? (
        <>
          <p className="agent-project-boundary">{harness?.kind === 'app-workflow'
            ? t("该技能编排应用内已有模型能力；所需模型由用户独立安装和选择。")
            : t("资源由本模型管理，当前 Harness 使用宿主提供的执行器。")}</p>
          {([
            [t("输入要求"), project.usage.inputRequirements],
            [t("使用示例"), project.usage.examples],
            [t("使用限制"), project.usage.limitations],
          ] as const).map(([title, items]) => items.length > 0 && (
            <div className="agent-usage" key={title}>
              <h3>{title}</h3>
              <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{t(item)}</li>)}</ul>
            </div>
          ))}
        </>
      ) : (
        <p className="agent-project-boundary">{t("保留原有运行方式。迁移为模型资源后，可声明使用说明、资源和 Harness。")}</p>
      )}
    </section>
  )
}
