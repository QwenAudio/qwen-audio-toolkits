//! Independent data-processing projects. The first protocol uses reviewed host adapters;
//! a project owns its resources and configuration, never another installed agent.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUsage {
    pub input_requirements: Vec<String>,
    pub limitations: Vec<String>,
    pub examples: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHarness {
    pub kind: String,
    pub adapter: String,
    pub capability: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProject {
    pub task: String,
    pub usage: AgentUsage,
    pub harness: AgentHarness,
}

impl AgentProject {
    pub fn validate(&self, adapter: &str, capabilities: &[String]) -> Result<(), String> {
        if self.task.trim().is_empty() || self.usage.input_requirements.is_empty() {
            return Err("Agent 必须声明任务和输入要求".into());
        }
        if self.harness.kind != "host-adapter" {
            return Err("当前 Agent 仅支持 host-adapter Harness".into());
        }
        if self.harness.adapter != adapter || capabilities != [self.harness.capability.clone()] {
            return Err("Agent Harness 与模型执行契约不一致".into());
        }
        for item in self
            .usage
            .input_requirements
            .iter()
            .chain(&self.usage.limitations)
            .chain(&self.usage.examples)
        {
            if item.trim().is_empty() {
                return Err("Agent 使用说明不能包含空条目".into());
            }
        }
        Ok(())
    }
}

/// Translate the public agent.json contract into the existing resource installer.
/// Unknown fields are rejected rather than silently ignoring executable/dependency declarations.
pub fn normalize_project(mut value: Value) -> Result<Value, String> {
    let object = value.as_object_mut().ok_or("agent.json 必须是对象")?;
    for key in object.keys() {
        if ![
            "$schema",
            "schemaVersion",
            "kind",
            "id",
            "name",
            "version",
            "publisher",
            "description",
            "license",
            "task",
            "usage",
            "harness",
            "runtime",
            "models",
            "inputs",
            "outputs",
            "parameters",
            "acceleration",
            "tone",
            "featured",
        ]
        .contains(&key.as_str())
        {
            return Err(format!(
                "Agent 不支持字段 {key}；资源必须属于项目自身，不能依赖其他 Agent"
            ));
        }
    }
    if object.get("schemaVersion") != Some(&json!(1))
        || object.get("kind") != Some(&json!("data-processing-agent"))
    {
        return Err("不支持的 Agent 项目版本或类型".into());
    }
    let project: AgentProject = serde_json::from_value(json!({
        "task": object.remove("task"),
        "usage": object.remove("usage"),
        "harness": object.remove("harness"),
    }))
    .map_err(|error| format!("Agent 定义无效: {error}"))?;
    project.validate(
        &project.harness.adapter,
        &[project.harness.capability.clone()],
    )?;
    if object.get("models").and_then(Value::as_array).map(Vec::len) != Some(1) {
        return Err("Agent v1 必须选择一个模型资源包；附属模型通过该包的 files/assets 声明".into());
    }
    for field in ["inputs", "outputs"] {
        if !object
            .get(field)
            .and_then(Value::as_array)
            .is_some_and(|ports| !ports.is_empty())
        {
            return Err(format!("Agent 必须声明 {field}"));
        }
    }
    object.remove("kind");
    object.remove("$schema");
    object.insert("schemaVersion".into(), json!(2));
    object.insert("adapter".into(), json!(project.harness.adapter));
    object.insert("capabilities".into(), json!([project.harness.capability]));
    object.insert(
        "agent".into(),
        serde_json::to_value(project).map_err(|e| e.to_string())?,
    );
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> Value {
        serde_json::from_str(include_str!("../../examples/agents/3d-speaker/agent.json")).unwrap()
    }

    #[test]
    fn translates_project_without_external_agent_dependencies() {
        let normalized = normalize_project(project()).unwrap();
        assert_eq!(normalized["adapter"], "speaker-embedding");
        assert_eq!(normalized["capabilities"], json!(["speaker.embed"]));
        assert!(normalized.get("recommendedDependencies").is_none());
        assert!(!normalized["agent"]["usage"]["examples"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_dependencies_unknown_runtimes_and_missing_contract() {
        let mut external = project();
        external["recommendedDependencies"] = json!([{"pluginId": "other.agent"}]);
        assert!(normalize_project(external).is_err());
        let mut executable = project();
        executable["harness"]["kind"] = json!("shell");
        assert!(normalize_project(executable).is_err());
        let mut missing = project();
        missing["inputs"] = json!([]);
        assert!(normalize_project(missing).is_err());
    }
}
