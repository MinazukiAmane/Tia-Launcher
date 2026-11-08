use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let directory = PathBuf::from(args.next().context("Missing release directory")?);
    let version = args
        .next()
        .context("Missing version")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("Invalid version"))?;
    let expected = semver::Version::parse(&version)?;
    ensure!(
        args.next().is_none(),
        "Unexpected release verification argument"
    );
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../native-updates.json"))?;
    let key = String::from_utf8(
        STANDARD.decode(config["publicKey"].as_str().context("Missing public pin")?)?,
    )?;
    let key = minisign_verify::PublicKey::decode(&key)?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("release-artifacts.json"))?)?;
    for artifact in manifest["native"]
        .as_array()
        .context("Missing native artifacts")?
    {
        let name = artifact["file"].as_str().context("Missing artifact name")?;
        ensure!(
            !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != "..",
            "Invalid artifact name"
        );
        let path = directory.join(name);
        let metadata = std::fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file() && metadata.len() <= 512 * 1024 * 1024,
            "Invalid or oversized update artifact"
        );
        let encoded = std::fs::read_to_string(directory.join(format!("{name}.sig")))?;
        let signature = String::from_utf8(STANDARD.decode(encoded.trim())?)?;
        let signature = minisign_verify::Signature::decode(&signature)?;
        key.verify(&std::fs::read(path)?, &signature, true)?;
        let versions: Vec<_> = signature
            .trusted_comment()
            .split('\t')
            .filter_map(|field| field.strip_prefix("version:"))
            .collect();
        ensure!(
            versions.len() == 1 && semver::Version::parse(versions[0])? == expected,
            "Signature version mismatch"
        );
        println!("Verified signed update: {name}");
    }
    Ok(())
}
