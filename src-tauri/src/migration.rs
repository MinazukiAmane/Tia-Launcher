use crate::{
    cipher::RecordCipher,
    keystore::{atomic_private_file, import_key},
};
use anyhow::{Result, bail};
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf};
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRequest {
    pub protocol: u8,
    pub nonce: String,
    pub profile: PathBuf,
    pub root_key: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub protocol: u8,
    pub nonce: String,
    pub database_sha256: String,
    pub records_verified: usize,
    pub proof: String,
}

pub fn import(mut request: ImportRequest, native: bool) -> Result<Receipt> {
    if request.protocol != 1
        || request.nonce.len() != 64
        || hex::decode(&request.nonce).is_err()
        || !request.profile.is_absolute()
    {
        bail!("Invalid migration request.")
    }
    let root = std::fs::canonicalize(&request.profile)?;
    let raw = Zeroizing::new(
        hex::decode(&request.root_key).map_err(|_| anyhow::anyhow!("Invalid migration key."))?,
    );
    request.root_key.zeroize();
    let key: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid migration key."))?;
    let key = Zeroizing::new(key);
    let cipher = RecordCipher::new(&key);
    let path = root.join("launcher.db");
    let info = std::fs::symlink_metadata(&path)?;
    if !info.is_file() || info.file_type().is_symlink() {
        bail!("Invalid migration database.")
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != 2 {
        bail!("The Electron migration update must prepare the database first.")
    }
    db.execute_batch("BEGIN;")?;
    let mut statement = db.prepare("SELECT scope,name,value FROM records")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut records = 0;
    for row in rows {
        let (scope, name, raw) = row?;
        let plain = cipher.open(&scope, &name, &raw)?;
        let _: serde_json::Value = serde_json::from_str(&plain)?;
        records += 1;
    }
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(&path)?;
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let digest = hex::encode(hasher.finalize());
    import_key(&root, &key, native)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&*key).expect("key length");
    mac.update(&serde_json::to_vec(&[
        "tia-migration-v1",
        &request.nonce,
        &digest,
        &records.to_string(),
    ])?);
    let receipt = Receipt {
        protocol: 1,
        nonce: request.nonce,
        database_sha256: digest,
        records_verified: records,
        proof: hex::encode(mac.finalize().into_bytes()),
    };
    atomic_private_file(
        &root.join("migration-receipt.json"),
        &serde_json::to_vec(&receipt)?,
    )?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_key_without_touching_source() {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("launcher.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE records(scope TEXT,name TEXT,value TEXT);PRAGMA user_version=2;",
        )
        .unwrap();
        let raw = RecordCipher::new(&[1; 32])
            .seal("launcher", "settings", "{}")
            .unwrap();
        db.execute("INSERT INTO records VALUES('launcher','settings',?)", [raw])
            .unwrap();
        drop(db);
        assert!(
            import(
                ImportRequest {
                    protocol: 1,
                    nonce: "a".repeat(64),
                    profile: dir.path().to_owned(),
                    root_key: hex::encode([2; 32])
                },
                false
            )
            .is_err()
        );
        assert!(!dir.path().join("launcher.tauri.key").exists());
    }
}
