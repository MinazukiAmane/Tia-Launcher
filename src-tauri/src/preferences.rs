use crate::store::Store;
use anyhow::{Result, bail};
use serde_json::{Value, json};
fn scope(biz: &str) -> String {
    if biz == "csore_global" {
        "launcher".into()
    } else {
        format!("title:{biz}")
    }
}
pub fn read(store: &Store, biz: &str) -> Result<Value> {
    let mut value = json!({"backgroundMode":null,"confirmedInstallDir":null});
    if let Some(Value::Object(saved)) = store.get("launcher", "preferences")? {
        for (key, item) in saved {
            value[key] = item;
        }
    }
    if biz != "csore_global" {
        value["confirmedInstallDir"] = store
            .get(&scope(biz), "preferences")?
            .map(|v| v["confirmedInstallDir"].clone())
            .unwrap_or(Value::Null);
    }
    Ok(value)
}
pub fn merge(mut value: Value, update: &Value, only_missing: bool) -> Result<Value> {
    if !update.is_object() {
        bail!("Invalid launcher preferences.")
    }
    if let Some(mode) = update.get("backgroundMode") {
        if !mode.is_null() && mode != "image" && mode != "video" {
            bail!("Invalid background mode.")
        }
        if !only_missing || value["backgroundMode"].is_null() {
            value["backgroundMode"] = mode.clone();
        }
    }
    if let Some(language) = update.get("launcherLanguage") {
        let languages: Value =
            serde_json::from_str(include_str!("../../src/shared/launcherLanguages.json"))?;
        if !languages
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["code"] == *language)
        {
            bail!("Unsupported launcher language.")
        }
        if !only_missing || value["launcherLanguage"].is_null() {
            value["launcherLanguage"] = language.clone();
        }
    }
    if let Some(directory) = update.get("confirmedInstallDir") {
        if !directory.is_null()
            && !directory
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 32768)
        {
            bail!("Invalid installation folder.")
        }
        if !only_missing || value["confirmedInstallDir"].is_null() {
            value["confirmedInstallDir"] = directory.clone();
        }
    }
    Ok(value)
}
pub fn write(store: &Store, biz: &str, value: &Value) -> Result<()> {
    if biz == "csore_global" {
        return store.put("launcher", "preferences", value);
    }
    let mut global = value.clone();
    global["confirmedInstallDir"] = store
        .get("launcher", "preferences")?
        .map(|v| v["confirmedInstallDir"].clone())
        .unwrap_or(Value::Null);
    store.put_scoped(&[
        (
            scope(biz),
            "preferences".into(),
            json!({"confirmedInstallDir":value["confirmedInstallDir"]}),
        ),
        ("launcher".into(), "preferences".into(), global),
    ])
}
