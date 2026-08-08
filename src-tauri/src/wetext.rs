use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    os::raw::c_char,
    path::{Path, PathBuf},
};

unsafe extern "C" {
    fn wetext_apply_rule(
        rule_path: *const c_char,
        input: *const c_char,
        error: *mut *mut c_char,
    ) -> *mut c_char;
    fn wetext_free_string(value: *mut c_char);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operator {
    Tn,
    Itn,
}

impl Operator {
    fn parse(value: Option<&str>) -> Self {
        if value.is_some_and(|value| value.eq_ignore_ascii_case("itn")) {
            Self::Itn
        } else {
            Self::Tn
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Tn => "tn",
            Self::Itn => "itn",
        }
    }
}

pub fn normalize_text(model_root: &Path, text: &str, parameters: &Value) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("请输入需要处理的文本".to_string());
    }
    let fsts = find_fst_root(model_root)?;
    let operator = Operator::parse(parameters.get("operator").and_then(Value::as_str));
    let requested_language = parameters
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let language = if matches!(requested_language, "zh" | "en" | "ja") {
        requested_language
    } else {
        detect_language(text)
    };

    let mut normalized = text.to_string();
    if bool_parameter(parameters, "traditionalToSimple", false) {
        normalized = apply_rule(&fsts.join("traditional_to_simple.fst"), &normalized)?;
    }

    if should_normalize(
        &normalized,
        language,
        operator,
        bool_parameter(parameters, "removeErhua", false),
    ) {
        let tagger_name = if operator == Operator::Itn
            && language != "en"
            && bool_parameter(parameters, "enable0To9", false)
        {
            "tagger_enable_0_to_9.fst"
        } else {
            "tagger.fst"
        };
        let tagger = fsts
            .join(language)
            .join(operator.as_str())
            .join(tagger_name);
        let tagged = apply_rule(&tagger, &normalized)?;
        let reordered = reorder_tokens(&tagged, language, operator)?;
        let verbalizer_name = if operator == Operator::Tn
            && language == "zh"
            && bool_parameter(parameters, "removeErhua", false)
        {
            "verbalizer_remove_erhua.fst"
        } else {
            "verbalizer.fst"
        };
        normalized = apply_rule(
            &fsts
                .join(language)
                .join(operator.as_str())
                .join(verbalizer_name),
            &reordered,
        )?;
    }

    for (enabled, rule) in [
        (
            bool_parameter(parameters, "fullToHalf", true),
            "full_to_half.fst",
        ),
        (
            bool_parameter(parameters, "removeInterjections", false),
            "remove_interjections.fst",
        ),
        (
            bool_parameter(parameters, "removePunctuation", false),
            "remove_puncts.fst",
        ),
        (bool_parameter(parameters, "tagOov", false), "tag_oov.fst"),
    ] {
        if enabled {
            normalized = apply_rule(&fsts.join(rule), &normalized)?;
        }
    }

    Ok(json!({
        "text": normalized.trim(),
        "originalText": text,
        "language": language,
        "operator": operator.as_str(),
        "engine": "kaldifst",
    }))
}

fn bool_parameter(parameters: &Value, key: &str, default: bool) -> bool {
    parameters
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn find_fst_root(model_root: &Path) -> Result<PathBuf, String> {
    for candidate in [
        model_root.join("wetext/fsts"),
        model_root.join("fsts"),
        model_root.to_path_buf(),
    ] {
        if candidate.join("zh/tn/tagger.fst").is_file()
            && candidate.join("zh/itn/tagger.fst").is_file()
        {
            return Ok(candidate);
        }
    }
    Err("WeText 模型目录缺少 wetext/fsts 规则文件".to_string())
}

fn detect_language(text: &str) -> &'static str {
    if text
        .chars()
        .any(|character| matches!(character as u32, 0x3040..=0x30ff))
    {
        "ja"
    } else if text
        .chars()
        .any(|character| matches!(character as u32, 0x3400..=0x9fff))
        || text.chars().all(|character| character.is_ascii_digit())
    {
        "zh"
    } else {
        "en"
    }
}

fn should_normalize(text: &str, language: &str, operator: Operator, remove_erhua: bool) -> bool {
    if operator == Operator::Tn && language != "en" {
        text.chars().any(|character| character.is_ascii_digit())
            || (remove_erhua && text.contains(['儿', '兒']))
    } else {
        !text.is_empty()
    }
}

fn apply_rule(rule: &Path, input: &str) -> Result<String, String> {
    if !rule.is_file() {
        return Err(format!("WeText 缺少规则 {}", rule.display()));
    }
    let rule = CString::new(rule.to_string_lossy().as_bytes())
        .map_err(|_| "WeText 规则路径包含非法字符".to_string())?;
    let input = CString::new(input).map_err(|_| "输入文本包含不受支持的空字符".to_string())?;
    let mut error = std::ptr::null_mut();
    let output = unsafe { wetext_apply_rule(rule.as_ptr(), input.as_ptr(), &mut error) };
    if output.is_null() {
        let message = if error.is_null() {
            "kaldifst 未能生成归一化路径".to_string()
        } else {
            let message = unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned();
            unsafe { wetext_free_string(error) };
            message
        };
        return Err(format!("WeText 运行失败: {message}"));
    }
    let result = unsafe { CStr::from_ptr(output) }
        .to_string_lossy()
        .into_owned();
    unsafe { wetext_free_string(output) };
    if result.is_empty() {
        Err("WeText 未找到可用的归一化路径".to_string())
    } else {
        Ok(result)
    }
}

#[derive(Debug)]
struct Token {
    name: String,
    fields: Vec<(String, String)>,
}

fn reorder_tokens(input: &str, language: &str, operator: Operator) -> Result<String, String> {
    let tokens = parse_tokens(input)?;
    let orders = token_orders(language, operator);
    Ok(tokens
        .into_iter()
        .map(|token| serialize_token(token, &orders))
        .collect::<Vec<_>>()
        .join(" "))
}

fn parse_tokens(input: &str) -> Result<Vec<Token>, String> {
    let characters = input.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut tokens = Vec::new();
    while skip_spaces(&characters, &mut index) {
        let name = parse_identifier(&characters, &mut index);
        consume_until(&characters, &mut index, '{')?;
        index += 1;
        let mut fields = Vec::new();
        loop {
            skip_spaces(&characters, &mut index);
            if characters.get(index) == Some(&'}') {
                index += 1;
                break;
            }
            let key = parse_identifier(&characters, &mut index);
            consume_until(&characters, &mut index, '"')?;
            index += 1;
            let mut value = String::new();
            while let Some(character) = characters.get(index).copied() {
                index += 1;
                if character == '"' {
                    break;
                }
                if character == '\\' {
                    let escaped = characters
                        .get(index)
                        .copied()
                        .ok_or_else(|| "WeText token 转义不完整".to_string())?;
                    index += 1;
                    value.push(escaped);
                } else {
                    value.push(character);
                }
            }
            if key.is_empty() {
                return Err("WeText token 字段为空".to_string());
            }
            fields.push((key, value));
        }
        if name.is_empty() {
            return Err("WeText token 类型为空".to_string());
        }
        tokens.push(Token { name, fields });
    }
    Ok(tokens)
}

fn skip_spaces(characters: &[char], index: &mut usize) -> bool {
    while characters
        .get(*index)
        .is_some_and(|character| character.is_whitespace())
    {
        *index += 1;
    }
    *index < characters.len()
}

fn parse_identifier(characters: &[char], index: &mut usize) -> String {
    let mut value = String::new();
    while characters
        .get(*index)
        .is_some_and(|character| character.is_ascii_alphabetic() || *character == '_')
    {
        value.push(characters[*index]);
        *index += 1;
    }
    value
}

fn consume_until(characters: &[char], index: &mut usize, expected: char) -> Result<(), String> {
    while let Some(character) = characters.get(*index) {
        if *character == expected {
            return Ok(());
        }
        *index += 1;
    }
    Err(format!("WeText token 缺少 {expected}"))
}

fn serialize_token(
    token: Token,
    orders: &HashMap<&'static str, &'static [&'static str]>,
) -> String {
    let preserve_order = token
        .fields
        .iter()
        .any(|(key, value)| key == "preserve_order" && value == "true");
    let mut fields = Vec::new();
    if !preserve_order {
        if let Some(order) = orders.get(token.name.as_str()) {
            for key in *order {
                if let Some(field) = token.fields.iter().find(|(name, _)| name == key) {
                    fields.push(field.clone());
                }
            }
        }
    }
    for field in token.fields {
        if !fields.iter().any(|(key, _)| key == &field.0) {
            fields.push(field);
        }
    }
    let body = fields
        .into_iter()
        .map(|(key, value)| {
            format!(
                r#" {key}: "{}""#,
                value.replace('\\', r"\\").replace('"', r#"\""#)
            )
        })
        .collect::<String>();
    format!("{} {{{body} }}", token.name)
}

fn token_orders(
    language: &str,
    operator: Operator,
) -> HashMap<&'static str, &'static [&'static str]> {
    let pairs: &[(&str, &[&str])] = if language == "en" && operator == Operator::Tn {
        &[
            ("date", &["preserve_order", "text", "day", "month", "year"]),
            (
                "money",
                &[
                    "integer_part",
                    "fractional_part",
                    "quantity",
                    "currency_maj",
                ],
            ),
        ]
    } else if operator == Operator::Tn {
        &[
            ("date", &["year", "month", "day"]),
            ("fraction", &["denominator", "numerator"]),
            ("measure", &["denominator", "numerator", "value"]),
            ("money", &["value", "currency"]),
            ("time", &["noon", "hour", "minute", "second"]),
        ]
    } else {
        &[
            ("date", &["year", "month", "day", "preserve_order"]),
            ("fraction", &["sign", "numerator", "denominator"]),
            ("measure", &["numerator", "denominator", "value", "units"]),
            ("money", &["currency", "value", "decimal", "quantity"]),
            ("time", &["hour", "minute", "second", "noon", "zone"]),
            ("telephone", &["country_code", "number_part"]),
            ("electronic", &["username", "domain", "protocol"]),
        ]
    };
    pairs.iter().copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_languages() {
        assert_eq!(detect_language("今天是 7 月 30 日"), "zh");
        assert_eq!(detect_language("1234"), "zh");
        assert_eq!(detect_language("今日は"), "ja");
        assert_eq!(detect_language("hello"), "en");
    }

    #[test]
    fn reorders_chinese_date_fields() {
        let output = reorder_tokens(
            r#"date { day: "30" year: "2026" month: "7" }"#,
            "zh",
            Operator::Tn,
        )
        .unwrap();
        assert_eq!(output, r#"date { year: "2026" month: "7" day: "30" }"#);
    }

    #[test]
    fn preserves_explicit_field_order() {
        let output = reorder_tokens(
            r#"date { day: "30" preserve_order: "true" year: "2026" }"#,
            "en",
            Operator::Tn,
        )
        .unwrap();
        assert_eq!(
            output,
            r#"date { day: "30" preserve_order: "true" year: "2026" }"#
        );
    }

    #[test]
    #[ignore = "requires an extracted WeText model package"]
    fn normalizes_with_real_wfst_rules() {
        let model = std::env::var("WETEXT_TEST_MODEL").unwrap();
        let result = normalize_text(
            Path::new(&model),
            "今天是2026年7月30日",
            &json!({"operator": "tn", "language": "zh"}),
        )
        .unwrap();
        assert_eq!(result["text"], "今天是二零二六年七月三十日");

        let result = normalize_text(
            Path::new(&model),
            "二零二六年七月三十日",
            &json!({"operator": "itn", "language": "zh"}),
        )
        .unwrap();
        assert_eq!(result["text"], "2026/07/30");
    }
}
