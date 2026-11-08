use crate::manifest::ManifestFile;
use serde::{Deserialize, Deserializer, Serialize};
fn number<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    v.as_u64()
        .or_else(|| v.as_str()?.parse().ok())
        .ok_or_else(|| serde::de::Error::custom("Invalid package size"))
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Package {
    pub url: String,
    pub md5: String,
    #[serde(deserialize_with = "number")]
    pub size: u64,
    #[serde(default, deserialize_with = "number")]
    pub decompressed_size: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Version {
    pub version: String,
    pub game_pkgs: Vec<Package>,
    #[serde(default)]
    pub audio_pkgs: Vec<Package>,
    pub res_list_url: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Main {
    #[serde(default)]
    pub required_client_version: String,
    pub major: Option<Version>,
    #[serde(default)]
    pub patches: Vec<Version>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Info {
    #[serde(default)]
    pub game: serde_json::Value,
    pub main: Main,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Definition {
    pub biz: String,
    pub executable: String,
    #[serde(rename = "installFolder")]
    pub install_folder: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    #[serde(default = "csore")]
    pub game_biz: String,
    pub version: String,
    pub install_dir: String,
    #[serde(default)]
    pub files: Vec<InstalledFile>,
    #[serde(default)]
    pub needs_repair: bool,
}
fn csore() -> String {
    "csore_global".into()
}
#[derive(Clone, Serialize, Deserialize)]
pub struct InstalledFile {
    pub path: String,
    pub md5: String,
}
impl From<&ManifestFile> for InstalledFile {
    fn from(f: &ManifestFile) -> Self {
        Self {
            path: f.path.clone(),
            md5: f.md5.clone(),
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub ok: bool,
    pub corrupt_files: Vec<String>,
    pub missing_files: Vec<String>,
}
#[derive(Serialize)]
pub struct OperationResult {
    pub status: &'static str,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAudio {
    pub to_version: String,
    pub audio_pkgs: Vec<Package>,
    #[serde(default)]
    pub base_files: Vec<InstalledFile>,
}
pub fn checkpoint_key(target: &Version) -> String {
    serde_json::to_string(&serde_json::json!([
        target.version,
        target
            .game_pkgs
            .iter()
            .map(|p| serde_json::json!([p.md5, p.size.to_string()]))
            .collect::<Vec<_>>()
    ]))
    .unwrap()
}
