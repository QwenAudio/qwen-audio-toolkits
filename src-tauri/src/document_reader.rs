use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DOCUMENT_CHARACTERS: usize = 300_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDocument {
    file_name: String,
    text: String,
    character_count: usize,
    truncated: bool,
}

fn decode_xml_entities(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(offset) = rest.find('&') {
        output.push_str(&rest[..offset]);
        rest = &rest[offset..];
        let Some(end) = rest.find(';').filter(|end| *end <= 12) else {
            output.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            value if value.starts_with("#x") => u32::from_str_radix(&value[2..], 16)
                .ok()
                .and_then(char::from_u32),
            value if value.starts_with('#') => {
                value[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(character) = decoded {
            output.push(character);
        } else {
            output.push_str(&rest[..=end]);
        }
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    output
}

fn extract_docx_text(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("DOCUMENT_READ:{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("DOCUMENT_INVALID_DOCX:{error}"))?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|error| format!("DOCUMENT_INVALID_DOCX:{error}"))?;
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|error| format!("DOCUMENT_INVALID_DOCX:{error}"))?;

    let mut output = String::new();
    let mut cursor = 0;
    let mut inside_text = false;
    while cursor < xml.len() {
        let Some(relative) = xml[cursor..].find('<') else {
            if inside_text {
                output.push_str(&decode_xml_entities(&xml[cursor..]));
            }
            break;
        };
        let tag_start = cursor + relative;
        if inside_text && tag_start > cursor {
            output.push_str(&decode_xml_entities(&xml[cursor..tag_start]));
        }
        let Some(relative_end) = xml[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + relative_end;
        let tag = &xml[tag_start + 1..tag_end];
        if tag.starts_with("w:t") {
            inside_text = true;
        } else if tag == "/w:t" {
            inside_text = false;
        } else if tag.starts_with("w:tab") && inside_text {
            output.push(' ');
        } else if tag.starts_with("w:br") || tag == "/w:p" {
            output.push('\n');
        }
        cursor = tag_end + 1;
    }
    Ok(output)
}

fn normalize_text(value: &str) -> String {
    let mut output = String::new();
    let mut previous_blank = false;
    for line in value.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = line.trim();
        if line.is_empty() {
            if !output.is_empty() && !previous_blank {
                output.push('\n');
                previous_blank = true;
            }
            continue;
        }
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(line);
        previous_blank = false;
    }
    output.trim().to_string()
}

#[tauri::command]
pub fn read_source_document(path: String) -> Result<SourceDocument, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(|error| format!("DOCUMENT_READ:{error}"))?;
    if !metadata.is_file() {
        return Err("DOCUMENT_NOT_FILE".to_string());
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("DOCUMENT_TOO_LARGE".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let raw = match extension.as_str() {
        "txt" | "md" | "markdown" => {
            fs::read_to_string(&path).map_err(|error| format!("DOCUMENT_READ:{error}"))?
        }
        "docx" => extract_docx_text(&path)?,
        "pdf" => pdf_extract::extract_text(&path)
            .map_err(|error| format!("DOCUMENT_INVALID_PDF:{error}"))?,
        _ => return Err("DOCUMENT_UNSUPPORTED".to_string()),
    };
    let normalized = normalize_text(&raw);
    if normalized.trim().is_empty() {
        return Err("DOCUMENT_EMPTY".to_string());
    }
    let character_count = normalized.chars().count();
    let truncated = character_count > MAX_DOCUMENT_CHARACTERS;
    let text = if truncated {
        normalized.chars().take(MAX_DOCUMENT_CHARACTERS).collect()
    } else {
        normalized
    };
    Ok(SourceDocument {
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document")
            .to_string(),
        text,
        character_count,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temporary_path(extension: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "qwenaudio-podcast-document-{}-{}.{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            extension
        ))
    }

    #[test]
    fn decodes_docx_entities() {
        assert_eq!(
            decode_xml_entities("A &amp; B &#x4E2D;&#25991;"),
            "A & B 中文"
        );
    }

    #[test]
    fn normalizes_blank_lines_without_joining_paragraphs() {
        assert_eq!(
            normalize_text(" first  \r\n\r\n\r\n second "),
            "first\n\nsecond"
        );
    }

    #[test]
    fn reads_plain_text_document() {
        let path = temporary_path("md");
        fs::write(&path, "# Title\n\nEvidence").expect("write markdown fixture");
        let result =
            read_source_document(path.to_string_lossy().into_owned()).expect("read markdown");
        assert_eq!(result.text, "# Title\n\nEvidence");
        assert!(!result.truncated);
        fs::remove_file(path).expect("remove markdown fixture");
    }

    #[test]
    fn reads_docx_paragraphs_and_entities() {
        let path = temporary_path("docx");
        let file = fs::File::create(&path).expect("create docx fixture");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("start document xml");
        archive
            .write_all(br#"<w:document><w:body><w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>"#)
            .expect("write document xml");
        archive.finish().expect("finish docx fixture");
        let result = read_source_document(path.to_string_lossy().into_owned()).expect("read docx");
        assert_eq!(result.text, "A & B\nSecond");
        fs::remove_file(path).expect("remove docx fixture");
    }
}
