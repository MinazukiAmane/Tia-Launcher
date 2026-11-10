use super::{
    archive,
    model::*,
    transfer,
    verify::{self, Cache},
    Control, Paused, Progress,
};
use crate::{
    manifest::{self, Manifest, Proof, PublicKey},
    paths,
    store::Store,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub struct Engine {
    pub store: Arc<Mutex<Store>>,
    pub control: Arc<Control>,
    pub api: String,
    pub client: reqwest::Client,
    keys: Vec<PublicKey>,
    recent: Mutex<HashMap<String, (Instant, Info)>>,
    unavailable: Mutex<HashMap<String, Instant>>,
    pub resources: PathBuf,
    pub runtime_checked: Mutex<HashMap<PathBuf, String>>,
}
impl Engine {
    pub fn new(store: Arc<Mutex<Store>>, api: String, resources: PathBuf) -> Result<Arc<Self>> {
        Self::with_keys(store, api, resources, manifest::pinned_keys()?)
    }
    pub fn with_keys(
        store: Arc<Mutex<Store>>,
        api: String,
        resources: PathBuf,
        keys: Vec<PublicKey>,
    ) -> Result<Arc<Self>> {
        transfer::validate_url(&api)?;
        Ok(Arc::new(Self {
            store,
            control: Arc::new(Control::default()),
            api,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(30))
                .user_agent("Tia-Launcher/2")
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if transfer::validate_url(attempt.url().as_str()).is_err() {
                        attempt.stop()
                    } else if attempt.previous().len() >= 10 {
                        attempt.error("Too many redirects")
                    } else {
                        attempt.follow()
                    }
                }))
                .build()?,
            keys,
            recent: Mutex::new(HashMap::new()),
            unavailable: Mutex::new(HashMap::new()),
            resources,
            runtime_checked: Mutex::new(HashMap::new()),
        }))
    }
    pub fn record(&self, message: &str) {
        let directory = self.store.lock().unwrap().directory.join("logs");
        if std::fs::create_dir_all(&directory).is_ok() {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(directory.join("launcher.log"))
            {
                let _ = writeln!(
                    file,
                    "{} [INFO] {}",
                    chrono::Utc::now().to_rfc3339(),
                    message
                );
            }
        }
    }
    pub async fn metadata(&self, biz: &str, play: bool) -> Result<Info> {
        if play {
            if let Some((at, value)) = self.recent.lock().unwrap().get(biz) {
                if at.elapsed() < Duration::from_secs(30) {
                    return Ok(value.clone());
                }
            }
            if self
                .unavailable
                .lock()
                .unwrap()
                .get(biz)
                .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
            {
                bail!("The update service is temporarily unavailable.")
            }
        }
        let attempts = if play { 1 } else { 3 };
        let mut error = anyhow::anyhow!("The game update service is unavailable.");
        for attempt in 0..attempts {
            let response = self
                .client
                .get(format!(
                    "{}/api/launcher_info",
                    self.api.trim_end_matches('/')
                ))
                .query(&[("game_biz", biz)])
                .timeout(Duration::from_secs(if play { 4 } else { 10 }))
                .header("Cache-Control", "no-cache")
                .send()
                .await;
            match response {
                Ok(response) => {
                    if response.status().is_success() {
                        transfer::validate_url(response.url().as_str())?;
                        let body: Value = serde_json::from_slice(
                            &transfer::bounded_body(response, 4 * 1024 * 1024).await?,
                        )?;
                        if body["retcode"] != 0 {
                            bail!("The update service returned an invalid response.")
                        }
                        let item = body["data"]["game_packages"]
                            .as_array()
                            .and_then(|items| items.iter().find(|i| i["game"]["biz"] == biz))
                            .context("The selected game is unavailable on the update service")?;
                        let mut info: Info = serde_json::from_value(item.clone())?;
                        info.launcher_update_required = super::policy::requires_update(
                            &info.main.required_client_version,
                            env!("CARGO_PKG_VERSION"),
                        )?;
                        self.store.lock().unwrap().put(
                            &format!("gamePolicy:{biz}"),
                            "requiredLauncher",
                            &json!(info.main.required_client_version),
                        )?;
                        self.recent
                            .lock()
                            .unwrap()
                            .insert(biz.to_owned(), (Instant::now(), info.clone()));
                        self.unavailable.lock().unwrap().remove(biz);
                        return Ok(info);
                    } else {
                        let status = response.status().as_u16();
                        let ray = response
                            .headers()
                            .get("cf-ray")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        error = anyhow::anyhow!(
                            "Update service HTTP {status}{}",
                            if ray.is_empty() {
                                String::new()
                            } else {
                                format!(" (Cloudflare Ray: {ray})")
                            }
                        );
                        if !matches!(status, 408 | 429 | 500 | 502 | 503 | 504 | 520..=524) {
                            break;
                        }
                    }
                }
                Err(_) => {
                    error = anyhow::anyhow!(
                        "The game update service could not be reached. Please retry."
                    )
                }
            }
            if attempt + 1 < attempts {
                tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
            }
        }
        if play {
            self.unavailable
                .lock()
                .unwrap()
                .insert(biz.to_owned(), Instant::now());
        }
        Err(error)
    }
    pub async fn remote_manifest(
        &self,
        game: &str,
        url: &str,
        play: bool,
    ) -> Result<(Manifest, Proof)> {
        transfer::validate_url(url)?;
        let response = self
            .client
            .get(url)
            .timeout(Duration::from_secs(if play { 4 } else { 15 }))
            .send()
            .await?
            .error_for_status()?;
        transfer::validate_url(response.url().as_str())?;
        let field = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned()
        };
        let key_id = field("X-Tia-Manifest-Key");
        let signature = field("X-Tia-Manifest-Signature");
        let game_biz = field("X-Tia-Manifest-Game");
        let body = String::from_utf8(transfer::bounded_body(response, 32 * 1024 * 1024).await?)?;
        let proof = Proof {
            key_id,
            signature,
            game_biz,
            body,
        };
        let manifest = manifest::authenticate_with_keys(&proof, game, &self.keys)?;
        verify::validate_files(&manifest.files)?;
        if manifest.files.is_empty() {
            bail!("The published game file list is empty.")
        }
        Ok((manifest, proof))
    }
    fn save_trusted(&self, root: &Path, manifest: &Manifest, proof: &Proof) -> Result<()> {
        let mut value = serde_json::to_value(manifest)?;
        value["proof"] = serde_json::to_value(proof)?;
        self.store
            .lock()
            .unwrap()
            .put(&paths::scope(root)?, "trustedManifest", &value)
    }
    pub fn install_state(&self, root: &Path, game: &Definition) -> Result<Option<Install>> {
        let scope = paths::scope(root)?;
        let saved = self.store.lock().unwrap().get(&scope, "install")?;
        if let Some(saved) = saved.filter(|v| !v.is_null()) {
            let mut state: Install = serde_json::from_value(saved)?;
            if state.game_biz != game.biz {
                return Ok(None);
            }
            state.install_dir = root.to_string_lossy().into_owned();
            return Ok(Some(state));
        }
        let legacy = paths::within(root, ".csore_install.json")?;
        if let Ok(info) = std::fs::symlink_metadata(&legacy) {
            if info.is_file() && !paths::linked(&info) && info.len() < 16 * 1024 * 1024 {
                if let Ok(mut state) = serde_json::from_slice::<Install>(&std::fs::read(legacy)?) {
                    if state.game_biz == game.biz {
                        state.files.clear();
                        state.needs_repair = true;
                        state.install_dir = root.to_string_lossy().into_owned();
                        self.store.lock().unwrap().put(
                            &scope,
                            "install",
                            &serde_json::to_value(&state)?,
                        )?;
                        return Ok(Some(state));
                    }
                }
            }
        }
        Ok(None)
    }
    pub async fn selected_state(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
    ) -> Result<Option<Install>> {
        if let Some(state) = self.install_state(root, game)? {
            return Ok(Some(state));
        }
        if self.control.busy.load(std::sync::atomic::Ordering::SeqCst)
            || self
                .store
                .lock()
                .unwrap()
                .get(&paths::scope(root)?, "checkpoint")?
                .is_some_and(|v| !v.is_null())
        {
            return Ok(None);
        }
        if paths::within(root, &game.executable)?.is_file() {
            let _operation = self.control.acquire()?;
            return Ok(Some(self.state_or_adopt(root, game).await?));
        }
        Ok(None)
    }
    async fn state_or_adopt(&self, root: &Path, game: &Definition) -> Result<Install> {
        if let Some(state) = self.install_state(root, game)? {
            return Ok(state);
        }
        if !paths::within(root, &game.executable)?.is_file() {
            bail!("Install the game before checking its files.")
        }
        let info = self.metadata(&game.biz, true).await?;
        let version = info.main.major.context("No game version is published")?;
        let (manifest, proof) = self
            .remote_manifest(&game.biz, &version.res_list_url, true)
            .await?;
        if manifest.version != version.version {
            bail!("The published game file list does not match its version.")
        }
        self.save_trusted(root, &manifest, &proof)?;
        let state = Install {
            game_biz: game.biz.clone(),
            version: manifest.version.clone(),
            install_dir: root.to_string_lossy().into_owned(),
            files: manifest.files.iter().map(InstalledFile::from).collect(),
            needs_repair: true,
        };
        self.store.lock().unwrap().put(
            &paths::scope(root)?,
            "install",
            &serde_json::to_value(&state)?,
        )?;
        Ok(state)
    }
    pub(super) async fn reference(
        &self,
        root: &Path,
        game: &Definition,
        state: &Install,
        quick: bool,
    ) -> Result<Manifest> {
        if let Ok(info) = self.metadata(&game.biz, quick).await {
            let version = info
                .main
                .major
                .as_ref()
                .filter(|v| v.version == state.version)
                .or_else(|| {
                    info.main
                        .patches
                        .iter()
                        .find(|v| v.version == state.version)
                });
            if let Some(version) = version {
                if let Ok((manifest, proof)) = self
                    .remote_manifest(&game.biz, &version.res_list_url, quick)
                    .await
                {
                    if manifest.version == state.version {
                        self.save_trusted(root, &manifest, &proof)?;
                        return Ok(manifest);
                    }
                }
            }
        }
        let saved = self
            .store
            .lock()
            .unwrap()
            .get(&paths::scope(root)?, "trustedManifest")?;
        if let Some(saved) = saved {
            if saved["version"] == state.version {
                let proof: Proof = serde_json::from_value(saved["proof"].clone())?;
                let manifest = manifest::authenticate_with_keys(&proof, &game.biz, &self.keys)?;
                if manifest.version == state.version {
                    return Ok(manifest);
                }
            }
        }
        bail!(
            "Connect to the internet once to confirm this installation. Afterwards you can play while the update service is unavailable."
        )
    }
    async fn check_files(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        manifest: Manifest,
        quick: bool,
    ) -> Result<Verification> {
        let scope = paths::scope(root)?;
        let cache = verify::read_cache(&self.store.lock().unwrap(), &scope);
        let engine = self.clone();
        let root = root.to_path_buf();
        let biz = game.biz.clone();
        let started = Instant::now();
        let (result, next, hashed) = tokio::task::spawn_blocking(move || {
            verify::check(&root, &biz, &manifest.files, quick, &cache, &engine.control)
        })
        .await??;
        self.record(&format!(
            "verify: completed durationMs={} hashedBytes={hashed} quick={quick}",
            started.elapsed().as_millis()
        ));
        self.store
            .lock()
            .unwrap()
            .put(&scope, "verifyCache", &serde_json::to_value(next)?)?;
        Ok(result)
    }
    pub async fn verify(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        quick: bool,
    ) -> Result<Verification> {
        let _operation = self.control.acquire()?;
        self.verify_inner(root, game, quick).await
    }
    pub async fn verify_inner(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        quick: bool,
    ) -> Result<Verification> {
        let state = self.state_or_adopt(root, game).await?;
        let scope = paths::scope(root)?;
        if self
            .store
            .lock()
            .unwrap()
            .get(&scope, "pendingAudio")?
            .is_some_and(|v| !v.is_null())
        {
            bail!("Finish the pending game update before playing.")
        }
        let manifest = self.reference(root, game, &state, quick).await?;
        let result = self
            .check_files(root, game, manifest, quick && !state.needs_repair)
            .await?;
        if result.ok && state.needs_repair {
            let state = Install {
                needs_repair: false,
                ..state
            };
            self.store
                .lock()
                .unwrap()
                .put(&scope, "install", &serde_json::to_value(state)?)?;
        }
        Ok(result)
    }
    pub(super) fn limit(&self) -> Option<u64> {
        self.store
            .lock()
            .unwrap()
            .get("launcher", "settings")
            .ok()
            .flatten()
            .and_then(|v| v["downloadSpeedLimitKbps"].as_u64())
            .filter(|n| *n > 0)
            .map(|n| n * 1024)
    }
    fn save_cache(&self, root: &Path, added: Cache) -> Result<()> {
        let scope = paths::scope(root)?;
        let store = self.store.lock().unwrap();
        let mut cache = verify::read_cache(&store, &scope);
        cache.extend(added);
        store.put(&scope, "verifyCache", &serde_json::to_value(cache)?)
    }
    async fn extract(
        self: &Arc<Self>,
        parts: Vec<PathBuf>,
        root: &Path,
        game: &Definition,
        target: &Manifest,
        progress: Progress,
        phase: &str,
    ) -> Result<()> {
        let engine = self.clone();
        let directory = root.to_path_buf();
        let biz = game.biz.clone();
        let files = target.files.clone();
        let phase = phase.to_owned();
        let cache = tokio::task::spawn_blocking(move || {
            archive::extract(
                &parts,
                &directory,
                &biz,
                &files,
                &engine.control,
                &progress,
                &phase,
            )
        })
        .await??;
        self.save_cache(root, cache)
    }
    fn dirty(&self, root: &Path, game: &Definition) -> Result<()> {
        if let Some(mut state) = self.install_state(root, game)? {
            state.needs_repair = true;
            self.store.lock().unwrap().put(
                &paths::scope(root)?,
                "install",
                &serde_json::to_value(state)?,
            )?;
        }
        Ok(())
    }
    async fn finish(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        target: &Manifest,
        proof: &Proof,
    ) -> Result<()> {
        let result = self.check_files(root, game, target.clone(), true).await?;
        if !result.ok {
            bail!("Some installed files are incomplete. Use Repair to finish this installation.")
        }
        let state = Install {
            game_biz: game.biz.clone(),
            version: target.version.clone(),
            install_dir: root.to_string_lossy().into_owned(),
            files: target.files.iter().map(InstalledFile::from).collect(),
            needs_repair: false,
        };
        let mut trusted = serde_json::to_value(target)?;
        trusted["proof"] = serde_json::to_value(proof)?;
        self.store.lock().unwrap().put_many(
            &paths::scope(root)?,
            &[
                ("install", serde_json::to_value(state)?),
                ("pendingAudio", Value::Null),
                ("checkpoint", Value::Null),
                ("trustedManifest", trusted),
            ],
        )?;
        Ok(())
    }
    async fn fresh(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        version: &Version,
        target: &Manifest,
        progress: Progress,
    ) -> Result<()> {
        let scope = paths::scope(root)?;
        let key = checkpoint_key(version);
        let checkpoint = self.store.lock().unwrap().get(&scope, "checkpoint")?;
        let mut resumed = false;
        if let Some(checkpoint) = checkpoint {
            if checkpoint["packageKey"] == key {
                if let Some(files) = checkpoint["files"].as_array() {
                    let target_map: HashMap<_, _> =
                        target.files.iter().map(|f| (f.path.as_str(), f)).collect();
                    let selected: Vec<_> = files
                        .iter()
                        .filter_map(|f| target_map.get(f["path"].as_str()?).copied())
                        .cloned()
                        .collect();
                    if selected.len() == files.len() && !selected.is_empty() {
                        resumed = self
                            .check_files(
                                root,
                                game,
                                Manifest {
                                    version: target.version.clone(),
                                    files: selected,
                                    repair_supported: target.repair_supported,
                                },
                                true,
                            )
                            .await?
                            .ok;
                    }
                }
            }
        }
        let parts_root = paths::within(root, ".csore_download_tmp/parts")?;
        if !resumed {
            let parts = transfer::parts(
                &self.client,
                &version.game_pkgs,
                &parts_root,
                self.limit(),
                &self.control,
                &progress,
                "downloading",
            )
            .await?;
            self.dirty(root, game)?;
            self.extract(parts, root, game, target, progress.clone(), "extracting")
                .await?;
            let cache = verify::read_cache(&self.store.lock().unwrap(), &scope);
            let files: Vec<_> = target
                .files
                .iter()
                .filter(|f| cache.get(&f.path).is_some_and(|c| c.md5 == f.md5))
                .map(InstalledFile::from)
                .collect();
            self.store.lock().unwrap().put(
                &scope,
                "checkpoint",
                &json!({"packageKey":key,"files":files}),
            )?;
        }
        if !version.audio_pkgs.is_empty() {
            let parts = transfer::parts(
                &self.client,
                &version.audio_pkgs,
                &parts_root,
                self.limit(),
                &self.control,
                &progress,
                "downloading_audio",
            )
            .await?;
            self.extract(parts, root, game, target, progress, "extracting_audio")
                .await?;
        }
        Ok(())
    }
    async fn apply_patch(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        packages: &[Package],
        target: &Manifest,
        old: &[InstalledFile],
        progress: Progress,
    ) -> Result<()> {
        let parts_root = paths::within(root, ".csore_download_tmp/parts")?;
        let parts = transfer::parts(
            &self.client,
            packages,
            &parts_root,
            self.limit(),
            &self.control,
            &progress,
            "downloading",
        )
        .await?;
        self.dirty(root, game)?;
        let engine = self.clone();
        let directory = root.to_path_buf();
        let biz = game.biz.clone();
        let files = target.files.clone();
        let old = old.to_vec();
        let cache = tokio::task::spawn_blocking(move || {
            archive::patch(
                &parts,
                &directory,
                &biz,
                &files,
                &old,
                &engine.control,
                &progress,
            )
        })
        .await??;
        self.save_cache(root, cache)?;

        Ok(())
    }
    async fn repair_inner(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        target: &Manifest,
        progress: Progress,
    ) -> Result<()> {
        if !target.repair_supported {
            bail!("The server does not offer per-file repair yet.")
        }
        let checked = self.check_files(root, game, target.clone(), false).await?;
        let damaged: std::collections::HashSet<_> = checked
            .missing_files
            .into_iter()
            .chain(checked.corrupt_files)
            .collect();
        let files: Vec<_> = target
            .files
            .iter()
            .filter(|f| damaged.contains(&f.path))
            .collect();
        let total = files.iter().map(|f| f.size).sum();
        let mut completed = 0u64;
        let staging = paths::within(root, ".csore_download_tmp/repair")?;
        paths::ensure_directory(&staging)?;
        let mut cache = Cache::new();
        for file in files {
            self.control.check()?;
            let url = file
                .url
                .clone()
                .context("The server did not provide a repair download")?;
            use sha2::{Digest, Sha256};
            let staged = staging.join(hex::encode(Sha256::digest(format!(
                "{}{}",
                file.path, file.md5
            ))));
            let package = Package {
                url,
                md5: file.md5.clone(),
                size: file.size,
                decompressed_size: 0,
            };
            transfer::download(
                &self.client,
                &package,
                &staged,
                self.limit(),
                &self.control,
                &progress,
                "downloading",
                completed,
                total,
            )
            .await?;
            let destination = paths::within(root, &file.path)?;
            paths::ensure_directory(destination.parent().unwrap())?;
            paths::within(root, &file.path)?;
            paths::replace(&staged, &destination)?;
            cache.insert(
                file.path.clone(),
                verify::Cached {
                    md5: file.md5.clone(),
                    stamp: verify::stamp(&destination)?,
                },
            );
            completed += file.size;
        }
        self.save_cache(root, cache)?;
        Ok(())
    }
    pub async fn update(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        progress: Progress,
    ) -> Result<OperationResult> {
        let _operation = self.control.acquire()?;
        let result = self.update_inner(root, game, progress).await;
        self.operation_result(root, result)
    }
    fn operation_result(&self, root: &Path, result: Result<()>) -> Result<OperationResult> {
        match result {
            Ok(()) => {
                let cache = paths::within(root, ".csore_download_tmp")?;
                let _ = std::fs::remove_dir_all(cache);
                self.record("installation: completed");
                Ok(OperationResult {
                    status: "completed",
                })
            }
            Err(error) if error.is::<Paused>() => {
                self.record("installation: paused; download cache retained");
                Ok(OperationResult { status: "paused" })
            }
            Err(error) => {
                self.record(&format!("installation: failed: {error}"));
                Err(error)
            }
        }
    }
    async fn update_inner(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        progress: Progress,
    ) -> Result<()> {
        let info = self.metadata(&game.biz, false).await?;
        super::policy::enforce(&info.main.required_client_version)?;
        let version = info.main.major.context("No game version is published")?;
        let (target, proof) = self
            .remote_manifest(&game.biz, &version.res_list_url, false)
            .await?;
        if target.version != version.version {
            bail!("The game manifest version is inconsistent.")
        }
        let state = self.install_state(root, game)?;
        let scope = paths::scope(root)?;
        let pending = self
            .store
            .lock()
            .unwrap()
            .get(&scope, "pendingAudio")?
            .filter(|v| !v.is_null())
            .map(serde_json::from_value::<PendingAudio>)
            .transpose()?;
        if let Some(pending) = pending.filter(|p| {
            p.to_version == version.version
                && state.as_ref().is_some_and(|s| s.version == p.to_version)
        }) {
            let old = if pending.base_files.is_empty() {
                state.as_ref().unwrap().files.clone()
            } else {
                pending.base_files
            };
            if let Err(error) = self
                .apply_patch(
                    root,
                    game,
                    &pending.audio_pkgs,
                    &target,
                    &old,
                    progress.clone(),
                )
                .await
            {
                if error.is::<archive::WrongBase>() && target.repair_supported {
                    self.repair_inner(root, game, &target, progress.clone())
                        .await?
                } else {
                    return Err(error);
                }
            }
        } else if let Some(state) = state.as_ref().filter(|s| s.version == version.version) {
            if state.needs_repair {
                self.repair_inner(root, game, &target, progress.clone())
                    .await?
            }
        } else if let Some(patch) = state
            .as_ref()
            .and_then(|s| info.main.patches.iter().find(|p| p.version == s.version))
        {
            let old = state.as_ref().unwrap().files.clone();
            match self
                .apply_patch(
                    root,
                    game,
                    &patch.game_pkgs,
                    &target,
                    &old,
                    progress.clone(),
                )
                .await
            {
                Ok(()) => {
                    if !patch.audio_pkgs.is_empty() {
                        let pending = PendingAudio {
                            to_version: version.version.clone(),
                            audio_pkgs: patch.audio_pkgs.clone(),
                            base_files: old.clone(),
                        };
                        let intermediate = Install {
                            game_biz: game.biz.clone(),
                            version: version.version.clone(),
                            install_dir: root.to_string_lossy().into_owned(),
                            files: old.clone(),
                            needs_repair: true,
                        };
                        self.store.lock().unwrap().put_many(
                            &scope,
                            &[
                                ("install", serde_json::to_value(intermediate)?),
                                ("pendingAudio", serde_json::to_value(&pending)?),
                            ],
                        )?;
                        if let Err(error) = self
                            .apply_patch(
                                root,
                                game,
                                &pending.audio_pkgs,
                                &target,
                                &old,
                                progress.clone(),
                            )
                            .await
                        {
                            if error.is::<archive::WrongBase>() && target.repair_supported {
                                self.repair_inner(root, game, &target, progress.clone())
                                    .await?
                            } else {
                                return Err(error);
                            }
                        }
                    }
                }
                Err(error) if error.is::<archive::WrongBase>() => {
                    if target.repair_supported {
                        self.repair_inner(root, game, &target, progress.clone())
                            .await?
                    } else {
                        self.fresh(root, game, &version, &target, progress.clone())
                            .await?
                    }
                }
                Err(error) => return Err(error),
            }
        } else {
            self.fresh(root, game, &version, &target, progress.clone())
                .await?;
        }
        self.finish(root, game, &target, &proof).await
    }
    pub async fn repair(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        progress: Progress,
    ) -> Result<OperationResult> {
        let _operation = self.control.acquire()?;
        let result = async {
            let info = self.metadata(&game.biz, false).await?;
            super::policy::enforce(&info.main.required_client_version)?;
            let state = self.state_or_adopt(root, game).await?;
            let version = info.main.major.context("No game version is published")?;
            if state.version != version.version && !state.needs_repair {
                bail!("Update the game before repairing it.")
            }
            let (target, proof) = self
                .remote_manifest(&game.biz, &version.res_list_url, false)
                .await?;
            if target.version != version.version {
                bail!("The repair manifest version is inconsistent.")
            }
            self.dirty(root, game)?;
            self.repair_inner(root, game, &target, progress).await?;
            self.finish(root, game, &target, &proof).await
        }
        .await;
        self.operation_result(root, result)
    }
}
