use super::engine::Engine;
use anyhow::{bail, Context, Result};

pub fn requires_update(required: &str, current: &str) -> Result<bool> {
    if required.is_empty() {
        return Ok(false);
    }
    fn parts(version: &str) -> Result<[u64; 4]> {
        let items: Vec<_> = version.split('.').collect();
        anyhow::ensure!(
            (3..=4).contains(&items.len()),
            "Invalid minimum launcher version"
        );
        let mut result = [0; 4];
        for (index, item) in items.iter().enumerate() {
            anyhow::ensure!(
                !item.is_empty() && item.bytes().all(|b| b.is_ascii_digit()),
                "Invalid minimum launcher version"
            );
            result[index] = item.parse().context("Invalid minimum launcher version")?;
        }
        Ok(result)
    }
    Ok(parts(current)? < parts(required)?)
}
pub fn enforce(required: &str) -> Result<()> {
    if requires_update(required, env!("CARGO_PKG_VERSION"))? {
        bail!("Update the launcher to continue. This game requires version {required} or newer.");
    }
    Ok(())
}
impl Engine {
    pub async fn check_launcher_policy(&self, biz: &str) -> Result<()> {
        match self.metadata(biz, true).await {
            Ok(info) => enforce(&info.main.required_client_version),
            Err(_) => {
                let minimum = self
                    .store
                    .lock()
                    .unwrap()
                    .get(&format!("gamePolicy:{biz}"), "requiredLauncher")?;
                enforce(minimum.as_ref().and_then(|v| v.as_str()).unwrap_or(""))
            }
        }
    }
}
