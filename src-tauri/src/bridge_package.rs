use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey, pkcs8::DecodePublicKey};
use serde::Deserialize;
use sha2::{Digest, Sha256, Sha512};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const LINK: &str = "/usr/bin/tia-launcher";
const LEGACY: &str = "/opt/Tia Launcher/tia-launcher";
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pacman,
    Deb,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRelease {
    body: String,
    #[serde(rename = "keyId")]
    key_id: String,
    signature: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Release {
    protocol: u8,
    app_id: String,
    bridge_version: String,
    target_version: String,
    platform: String,
    installer_sha512: String,
    helper_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    artifact: PathBuf,
    kind: Kind,
    release: SignedRelease,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pin {
    id: String,
    public_key: String,
}

fn trusted_release(signed: &SignedRelease, pins: &[Pin]) -> Result<Release> {
    let pin = pins
        .iter()
        .find(|pin| pin.id == signed.key_id)
        .context("Unknown migration signer")?;
    let key = VerifyingKey::from_public_key_pem(&pin.public_key)?;
    let signature = Signature::from_slice(&STANDARD.decode(&signed.signature)?)?;
    let mut message = b"Tia launcher framework migration v1\0".to_vec();
    message.extend_from_slice(signed.body.as_bytes());
    key.verify(&message, &signature)?;
    let release: Release = serde_json::from_str(&signed.body)?;
    ensure!(
        release.protocol == 1
            && release.app_id == "com.serenetia.tia-launcher"
            && release.platform
                == format!(
                    "linux-{}",
                    if cfg!(target_arch = "x86_64") {
                        "x64"
                    } else {
                        "arm64"
                    }
                ),
        "Wrong package migration identity"
    );
    let current = semver::Version::parse(&release.bridge_version)?;
    let target = semver::Version::parse(&release.target_version)?;
    ensure!(
        current.major == 1 && target.major >= 2 && target > current,
        "Invalid package migration versions"
    );
    Ok(release)
}
fn output(program: &str, args: &[&str]) -> Result<String> {
    let result = Command::new(program)
        .args(args)
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LC_ALL", "C")
        .output()?;
    ensure!(
        result.status.success(),
        "Package identity could not be verified"
    );
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
}
fn package_version(kind: Kind, version: &str) -> String {
    match kind {
        Kind::Pacman => format!("{}-1", version.replace(['-', '+'], "_")),
        Kind::Deb => version.into(),
    }
}
fn installed_version(kind: Kind) -> Result<String> {
    match kind {
        Kind::Pacman => {
            let text = output("/usr/bin/pacman", &["-Q", "tia-launcher"])?;
            Ok(text
                .strip_prefix("tia-launcher ")
                .context("Wrong installed package")?
                .into())
        }
        Kind::Deb => output(
            "/usr/bin/dpkg-query",
            &["-W", "-f=${Version}", "tia-launcher"],
        ),
    }
}
fn owns_link(kind: Kind) -> Result<bool> {
    let (program, args) = match kind {
        Kind::Pacman => ("/usr/bin/pacman", vec!["-Qoq", "--", LINK]),
        Kind::Deb => ("/usr/bin/dpkg-query", vec!["-S", LINK]),
    };
    let result = Command::new(program)
        .args(args)
        .env("LC_ALL", "C")
        .output()?;
    if result.status.success() {
        let owner = String::from_utf8(result.stdout)?;
        ensure!(
            match kind {
                Kind::Pacman => owner.trim() == "tia-launcher",
                Kind::Deb => owner.starts_with("tia-launcher:"),
            },
            "Another package owns the launcher entry"
        );
        return Ok(true);
    }
    let message = String::from_utf8_lossy(&result.stderr);
    ensure!(
        result.status.code() == Some(1)
            && match kind {
                Kind::Pacman => message.contains("No package owns /usr/bin/tia-launcher"),
                Kind::Deb => message.contains("no path found matching pattern"),
            },
        "The launcher entry ownership could not be verified"
    );
    Ok(false)
}
pub fn legacy_link(path: &Path, old: &Path, alternative: &Path) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let info = match std::fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if !info.file_type().is_symlink() {
        return Ok(false);
    }
    ensure!(info.uid() == 0, "The launcher link is not system-owned");
    let target = std::fs::read_link(path)?;
    if target == old {
        return Ok(true);
    }
    if target == alternative {
        let info = std::fs::symlink_metadata(alternative)?;
        ensure!(
            info.file_type().is_symlink() && info.uid() == 0,
            "The launcher alternative is not system-owned"
        );
        return Ok(std::fs::read_link(alternative)? == old);
    }
    Ok(false)
}
pub fn install(request: Request) -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "Approve the system update prompt first"
    );
    let executable = std::env::current_exe()?;
    crate::package_update::system_executable(&executable)?;
    let pins: Vec<Pin> = serde_json::from_str(include_str!("../../src/shared/migrationKeys.json"))?;
    let release = trusted_release(&request.release, &pins)?;
    ensure!(
        hex::encode(Sha256::digest(std::fs::read(&executable)?)) == release.helper_sha256,
        "The installed migration helper does not match its signed release"
    );
    ensure!(request.artifact.is_absolute(), "Invalid package path");
    let bytes = crate::package_update::read_regular(&request.artifact, 512 * 1024 * 1024)?;
    ensure!(
        STANDARD.encode(Sha512::digest(&bytes)) == release.installer_sha512,
        "The package did not match its signed migration proof"
    );
    ensure!(
        installed_version(request.kind)? == package_version(request.kind, &release.bridge_version),
        "The installed launcher changed; restart it before updating"
    );
    let manager = match request.kind {
        Kind::Pacman => "/usr/bin/pacman",
        Kind::Deb => "/usr/bin/apt-get",
    };
    crate::package_update::system_executable(&std::fs::canonicalize(manager)?)?;
    crate::package_update::system_executable(Path::new("/usr/bin"))?;
    let temporary = tempfile::Builder::new()
        .prefix("tia-bridge-package-")
        .tempdir_in("/var/tmp")?;
    let package = temporary.path().join(match request.kind {
        Kind::Pacman => "update.pacman",
        Kind::Deb => "update.deb",
    });
    std::fs::write(&package, &bytes)?;
    drop(bytes);
    let file = package.to_str().context("Invalid package location")?;
    let version = match request.kind {
        Kind::Pacman => {
            let text = output("/usr/bin/pacman", &["-Qp", "--", file])?;
            text.strip_prefix("tia-launcher ")
                .context("Wrong target package")?
                .to_owned()
        }
        Kind::Deb => {
            ensure!(
                output("/usr/bin/dpkg-deb", &["-f", file, "Package"])? == "tia-launcher",
                "Wrong target package"
            );
            output("/usr/bin/dpkg-deb", &["-f", file, "Version"])?
        }
    };
    ensure!(
        version == package_version(request.kind, &release.target_version),
        "Wrong target package version"
    );
    let missing = match std::fs::symlink_metadata(LINK) {
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    let owned = if !missing {
        owns_link(request.kind)?
    } else {
        false
    };
    let legacy = legacy_link(
        Path::new(LINK),
        Path::new(LEGACY),
        Path::new("/etc/alternatives/tia-launcher"),
    )?;
    ensure!(
        owned || legacy || missing,
        "A custom launcher entry must be resolved before updating"
    );
    let retire = matches!(request.kind, Kind::Pacman) && !owned && legacy;
    if matches!(request.kind, Kind::Pacman) {
        ensure!(
            !Path::new("/var/lib/pacman/db.lck").exists(),
            "Another package operation is running; try again after it finishes"
        )
    }
    let old = if retire {
        let target = std::fs::read_link(LINK)?;
        std::fs::remove_file(LINK)?;
        Some(target)
    } else {
        None
    };
    let result = (|| -> Result<()> {
        let status = match request.kind {
            Kind::Pacman => Command::new("/usr/bin/pacman")
                .args(["-U", "--noconfirm", "--", file])
                .env_clear()
                .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
                .env("LC_ALL", "C")
                .status()?,
            Kind::Deb => Command::new("/usr/bin/apt-get")
                .args(["install", "--yes", "--no-remove", file])
                .env_clear()
                .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
                .env("LC_ALL", "C")
                .env("DEBIAN_FRONTEND", "noninteractive")
                .status()?,
        };
        ensure!(
            status.success(),
            "The package manager could not finish the launcher update"
        );
        ensure!(
            installed_version(request.kind)? == version,
            "The installed package version could not be confirmed"
        );
        ensure!(
            std::fs::symlink_metadata(LINK)?.is_file(),
            "The updated launcher entry is missing"
        );
        Ok(())
    })();
    if result.is_err() {
        if let Some(target) = old {
            if matches!(std::fs::symlink_metadata(LINK), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
            {
                std::os::unix::fs::symlink(target, LINK)?
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};

    fn fixture() -> (SignedRelease, Vec<Pin>, SigningKey) {
        let key = SigningKey::from_bytes(&[37; 32]);
        let body = serde_json::json!({
            "protocol":1,"appId":"com.serenetia.tia-launcher",
            "bridgeVersion":"1.19.2","targetVersion":"2.0.0",
            "platform":format!("linux-{}", if cfg!(target_arch="x86_64") {"x64"} else {"arm64"}),
            "installerSha512":STANDARD.encode([0;64]),"helperSha256":"0".repeat(64)
        })
        .to_string();
        let mut signed = SignedRelease {
            body,
            key_id: "fixture".into(),
            signature: String::new(),
        };
        resign(&mut signed, &key);
        let pins = vec![Pin {
            id: "fixture".into(),
            public_key: key
                .verifying_key()
                .to_public_key_pem(Default::default())
                .unwrap(),
        }];
        (signed, pins, key)
    }
    fn resign(signed: &mut SignedRelease, key: &SigningKey) {
        let message = [
            b"Tia launcher framework migration v1\0".as_slice(),
            signed.body.as_bytes(),
        ]
        .concat();
        signed.signature = STANDARD.encode(key.sign(&message).to_bytes());
    }
    #[test]
    fn package_proofs_reject_changes_wrong_signers_and_wrong_identity() {
        let (mut signed, pins, key) = fixture();
        assert!(trusted_release(&signed, &pins).is_ok());
        signed.body.push(' ');
        assert!(trusted_release(&signed, &pins).is_err());
        let (mut signed, _, _) = fixture();
        signed.key_id = "unknown".into();
        assert!(trusted_release(&signed, &pins).is_err());
        for (field, value) in [
            ("appId", "other"),
            ("targetVersion", "1.18.0"),
            ("bridgeVersion", "2.0.0"),
            ("platform", "windows-x64"),
        ] {
            let (mut signed, _, _) = fixture();
            let mut body: serde_json::Value = serde_json::from_str(&signed.body).unwrap();
            body[field] = value.into();
            signed.body = body.to_string();
            resign(&mut signed, &key);
            assert!(trusted_release(&signed, &pins).is_err(), "{field}");
        }
    }
    #[test]
    fn ordinary_files_and_unrelated_links_are_never_legacy_entries() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("entry");
        let old = dir.path().join("old");
        let alternative = dir.path().join("alternative");
        assert!(!legacy_link(&entry, &old, &alternative).unwrap());
        std::fs::write(&entry, b"custom application").unwrap();
        assert!(!legacy_link(&entry, &old, &alternative).unwrap());
        std::fs::remove_file(&entry).unwrap();
        std::os::unix::fs::symlink(&old, &entry).unwrap();
        // User-owned symlinks must never be retired by a privileged update.
        if unsafe { libc::geteuid() } != 0 {
            assert!(legacy_link(&entry, &old, &alternative).is_err());
        }
    }
}
