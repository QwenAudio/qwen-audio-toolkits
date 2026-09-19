import type { AgentExtension } from '../types'

export function AgentProjectCard({ plugin }: { plugin: AgentExtension }) {
  const project = plugin.agent
  return (
    <section className="agent-project-card" aria-label="Agent 项目定义">
      <header>
        <strong>{project ? '独立 Agent 项目' : '旧版扩展'}</strong>
        <span>{project ? '数据处理' : '自定义旧协议'}</span>
      </header>
      <p>{project?.task ?? plugin.description}</p>
      <dl>
        <div><dt>模型 / API</dt><dd>{plugin.variants?.length
          ? plugin.variants.map((variant) => variant.name).join(' / ')
          : plugin.name}</dd></div>
        <div><dt>Harness</dt><dd>{project?.harness.adapter ?? plugin.adapter}</dd></div>
        <div><dt>运行环境</dt><dd>{plugin.runtime}</dd></div>
        <div><dt>输入</dt><dd>{plugin.inputs?.length
          ? plugin.inputs.map((port) => `${port.label || port.name}${port.optional ? '（可选）' : ''}`).join('、')
          : '由能力契约定义'}</dd></div>
        <div><dt>输出</dt><dd>{plugin.outputs?.length
          ? plugin.outputs.map((port) => port.label || port.name).join('、')
          : plugin.capabilities.join('、')}</dd></div>
      </dl>
      {project ? (
        <>
          <p className="agent-project-boundary">资源由本项目管理，不调用其他 Agent。当前 Harness 使用宿主提供的执行器。</p>
          {([
            ['输入要求', project.usage.inputRequirements],
            ['使用示例', project.usage.examples],
            ['使用限制', project.usage.limitations],
          ] as const).map(([title, items]) => items.length > 0 && (
            <div className="agent-usage" key={title}>
              <h3>{title}</h3>
              <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
            </div>
          ))}
        </>
      ) : (
        <p className="agent-project-boundary">保留原有运行方式。迁移为独立 Agent 后，可在项目中声明使用说明、资源和 Harness。</p>
      )}
    </section>
  )
}
