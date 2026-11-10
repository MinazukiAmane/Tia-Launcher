use super::{Paused, Progress, engine::Engine, model::*, policy, transfer};
use crate::paths;
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::json;
use std::{path::Path, sync::Arc};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: String,
    pub total_bytes: u64,
    pub ready: bool,
    pub launcher_update_required: bool,
    pub required_client_version: String,
}
fn plan(info: &Info, installed: Option<&Install>) -> Option<(Version, Vec<Package>)> {
    let target = info.pre_download.major.as_ref()?;
    if info
        .main
        .major
        .as_ref()
        .is_some_and(|v| v.version == target.version)
    {
        return None;
    }
    let download = installed
        .filter(|s| !s.needs_repair)
        .and_then(|s| {
            info.pre_download
                .patches
                .iter()
                .find(|p| p.version == s.version)
        })
        .or_else(|| info.enable_base_pkg_predownload.then_some(target))?;
    let packages = download
        .game_pkgs
        .iter()
        .chain(download.audio_pkgs.iter())
        .cloned()
        .collect();
    Some((target.clone(), packages))
}
fn identity(target: &Version, packages: &[Package]) -> String {
    serde_json::to_string(&json!([
        target.version,
        packages
            .iter()
            .map(|p| json!([p.md5, p.size]))
            .collect::<Vec<_>>()
    ]))
    .unwrap()
}
impl Engine {
    pub async fn predownload_status(
        &self,
        root: &Path,
        game: &Definition,
    ) -> Result<Option<Status>> {
        let info = self.metadata(&game.biz, true).await?;
        let installed = self.install_state(root, game)?;
        let Some((target, packages)) = plan(&info, installed.as_ref()) else {
            return Ok(None);
        };
        let total_bytes = packages
            .iter()
            .try_fold(0u64, |sum, p| sum.checked_add(p.size))
            .context("Package size overflow")?;
        let directory = paths::within(root, ".csore_download_tmp/parts")?;
        let saved = self
            .store
            .lock()
            .unwrap()
            .get(&paths::scope(root)?, "predownload")?;
        let ready = saved.as_ref().and_then(|v| v.as_str())
            == Some(identity(&target, &packages).as_str())
            && packages.iter().all(|p| {
                p.md5.len() == 32
                    && p.md5.bytes().all(|b| b.is_ascii_hexdigit())
                    && std::fs::symlink_metadata(directory.join(format!("part-{}", p.md5)))
                        .is_ok_and(|m| m.is_file() && !paths::linked(&m) && m.len() == p.size)
            });
        Ok(Some(Status {
            version: target.version,
            total_bytes,
            ready,
            launcher_update_required: policy::requires_update(
                &info.pre_download.required_client_version,
                env!("CARGO_PKG_VERSION"),
            )?,
            required_client_version: info.pre_download.required_client_version,
        }))
    }
    pub async fn predownload(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        progress: Progress,
    ) -> Result<OperationResult> {
        let _operation = self.control.acquire()?;
        let result = async {
            let info = self.metadata(&game.biz, false).await?;
            policy::enforce(&info.pre_download.required_client_version)?;
            let installed = self.install_state(root, game)?;
            let (target, packages) = plan(&info, installed.as_ref())
                .context("No predownload is available for this game.")?;
            let (manifest, _) = self
                .remote_manifest(&game.biz, &target.res_list_url, false)
                .await?;
            if manifest.version != target.version {
                bail!("The predownload manifest version is inconsistent.")
            }
            transfer::parts(
                &self.client,
                &packages,
                &paths::within(root, ".csore_download_tmp/parts")?,
                self.limit(),
                &self.control,
                &progress,
                "downloading",
            )
            .await?;
            self.store.lock().unwrap().put(
                &paths::scope(root)?,
                "predownload",
                &json!(identity(&target, &packages)),
            )?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        match result {
            Ok(()) => {
                self.record("predownload: completed; installed game unchanged");
                Ok(OperationResult {
                    status: "completed",
                })
            }
            Err(error) if error.is::<Paused>() => {
                self.record("predownload: paused; downloaded data retained");
                Ok(OperationResult { status: "paused" })
            }
            Err(error) => {
                self.record(&format!("predownload: failed: {error}"));
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_patch_only_for_a_healthy_matching_installation_and_keeps_audio() {
        let package = |name: &str| json!({"url":format!("https://example.com/{name}"),"md5":"d41d8cd98f00b204e9800998ecf8427e","size":"0"});
        let version = |v: &str, kind: &str| json!({"version":v,"game_pkgs":[package(kind)],"audio_pkgs":[package(&format!("{kind}-audio"))],"res_list_url":"https://example.com/manifest"});
        let mut info:Info=serde_json::from_value(json!({"main":{"major":version("1.0.0","live")},"pre_download":{"major":version("2.0.0","full"),"patches":[version("1.0.0","patch")]}})).unwrap();
        let mut installed = Install {
            game_biz: "csore_global".into(),
            version: "1.0.0".into(),
            install_dir: "Game".into(),
            files: vec![],
            needs_repair: false,
        };
        let (_, packages) = plan(&info, Some(&installed)).unwrap();
        assert!(packages[0].url.ends_with("/patch"));
        assert!(packages[1].url.ends_with("/patch-audio"));
        installed.needs_repair = true;
        assert!(plan(&info, Some(&installed)).is_none());
        assert!(plan(&info, None).is_none());
        info.enable_base_pkg_predownload = true;
        assert!(
            plan(&info, Some(&installed)).unwrap().1[0]
                .url
                .ends_with("/full")
        );
        assert!(plan(&info, None).unwrap().1[0].url.ends_with("/full"));
        info.main.major = info.pre_download.major.clone();
        assert!(plan(&info, None).is_none());
    }
}
