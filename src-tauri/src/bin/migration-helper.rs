use std::io::{Read, Write};
fn main() {
    let mut stage = "request";
    let result = (|| -> anyhow::Result<()> {
        let operation = std::env::args().nth(1).unwrap_or_default();
        #[cfg(target_os = "linux")]
        if operation == "--install-linux-package-stdin" {
            let mut input = Vec::new();
            std::io::stdin().take(32769).read_to_end(&mut input)?;
            anyhow::ensure!(input.len() <= 32768, "Package migration request too large");
            let request = serde_json::from_slice(&input)?;
            tia_launcher::bridge_package::install(request)?;
            return Ok(());
        }
        if !matches!(
            operation.as_str(),
            "--import-key-stdin" | "--recover-profile-stdin"
        ) {
            anyhow::bail!("Unsupported migration operation.")
        }
        let mut input = zeroize::Zeroizing::new(Vec::new());
        std::io::stdin().take(8193).read_to_end(&mut input)?;
        if input.len() > 8192 {
            anyhow::bail!("Migration request too large.")
        }
        let request: tia_launcher::migration::ImportRequest = if operation
            == "--recover-profile-stdin"
        {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Recover {
                protocol: u8,
                nonce: String,
                profile: std::path::PathBuf,
            }
            let request: Recover = serde_json::from_slice(&input)?;
            stage = "legacy key recovery";
            let key = tia_launcher::legacy_key::recover(&request.profile)?.ok_or_else(|| {
                anyhow::anyhow!("An Electron key handoff is required on this platform.")
            })?;
            tia_launcher::migration::ImportRequest {
                protocol: request.protocol,
                nonce: request.nonce,
                profile: request.profile,
                root_key: hex::encode(key.as_ref()),
            }
        } else {
            serde_json::from_slice(&input)
                .map_err(|_| anyhow::anyhow!("Invalid migration request."))?
        };
        stage = "authenticated database import";
        let receipt = tia_launcher::migration::import(request, !cfg!(target_os = "macos"))?;
        serde_json::to_writer(std::io::stdout().lock(), &receipt)?;
        std::io::stdout().write_all(b"\n")?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!(
            "Migration could not be verified. Original launcher data has not been replaced. Stage: {stage}. {error}"
        );
        std::process::exit(1)
    }
}
