use crate::cipher::RecordCipher;
use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Store {
    connection: Connection,
    cipher: RecordCipher,
    pub directory: PathBuf,
}
impl Store {
    pub fn open(directory: &Path, key: &[u8; 32]) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let path = directory.join("launcher.db");
        if !path.exists() && directory.join("launcher.db.bak").exists() {
            bail!("Saved launcher data is missing. Restore its backup before continuing.")
        }
        let connection = Connection::open(&path)?;
        connection.execute_batch(
            "PRAGMA busy_timeout=5000; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;",
        )?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE records(scope TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,name)); PRAGMA user_version=2; COMMIT;")?
        } else if version != 2 {
            bail!("Open the Electron migration update once before switching launchers.")
        }
        let store = Self {
            connection,
            cipher: RecordCipher::new(key),
            directory: directory.to_path_buf(),
        };
        store.verify_records()?;
        Ok(store)
    }
    pub fn verify_records(&self) -> Result<usize> {
        let mut statement = self
            .connection
            .prepare("SELECT scope,name,value FROM records")?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut count = 0;
        let mut discard = Vec::new();
        for row in rows {
            let (scope, name, raw) = row?;
            let valid = self
                .cipher
                .open(&scope, &name, &raw)
                .and_then(|plain| Ok(serde_json::from_str::<Value>(&plain)?));
            if let Err(error) = valid {
                if name == "verifyCache" {
                    discard.push(scope);
                    continue;
                }
                return Err(error);
            }
            count += 1;
        }
        drop(statement);
        for scope in discard {
            self.connection.execute(
                "DELETE FROM records WHERE scope=? AND name='verifyCache'",
                [scope],
            )?;
        }
        Ok(count)
    }
    pub fn get(&self, scope: &str, name: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM records WHERE scope=? AND name=?",
                params![scope, name],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|value| {
            Ok(serde_json::from_str(
                &self.cipher.open(scope, name, &value)?,
            )?)
        })
        .transpose()
    }
    pub fn put(&self, scope: &str, name: &str, value: &Value) -> Result<()> {
        if self
            .get(scope, name)
            .or_else(|error| {
                if name == "verifyCache" {
                    Ok(None)
                } else {
                    Err(error)
                }
            })?
            .as_ref()
            == Some(value)
        {
            return Ok(());
        }
        let raw = self
            .cipher
            .seal(scope, name, &serde_json::to_string(value)?)?;
        self.connection.execute("INSERT INTO records(scope,name,value) VALUES(?,?,?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value",params![scope,name,raw])?;
        Ok(())
    }
    pub fn has_installation_under(&self, directory: &Path) -> Result<bool> {
        let mut statement = self.connection.prepare(
            "SELECT scope,name FROM records WHERE name IN ('install','selectedInstallation')",
        )?;
        let records = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (scope, name) in records {
            if let Some(path) = self
                .get(&scope, &name)?
                .and_then(|value| value["installDir"].as_str().map(std::path::PathBuf::from))
            {
                if path.is_absolute()
                    && (path.starts_with(directory)
                        || std::fs::canonicalize(path)
                            .is_ok_and(|path| path.starts_with(directory)))
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    pub fn forget_game(&self, scope: &str, preference: &str) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        self.connection
            .execute("DELETE FROM records WHERE scope=?", [scope])?;
        self.put(
            preference,
            "selectedInstallation",
            &serde_json::json!({"installDir":null}),
        )?;
        if let Some(mut preferences) = self.get(preference, "preferences")? {
            preferences["confirmedInstallDir"] = Value::Null;
            self.put(preference, "preferences", &preferences)?;
        }
        transaction.commit()?;
        Ok(())
    }
    pub fn relocate_game(
        &self,
        source: &str,
        destination: &str,
        path: &Path,
        preference: &str,
    ) -> Result<()> {
        let visible_path = crate::paths::user_path(path);
        let path = visible_path.as_path();
        let mut statement = self
            .connection
            .prepare("SELECT name FROM records WHERE scope=?")?;
        let names = statement
            .query_map([source], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let transaction = self.connection.unchecked_transaction()?;
        if self
            .get(destination, "install")?
            .is_some_and(|value| !value.is_null())
        {
            bail!("This folder already belongs to another installation.")
        }
        self.connection
            .execute("DELETE FROM records WHERE scope=?", [destination])?;
        for name in names {
            if name == "verifyCache" {
                continue;
            }
            let mut value = self.get(source, &name)?.unwrap_or(Value::Null);
            if name == "install" && !value.is_null() {
                value["installDir"] = serde_json::json!(path)
            }
            self.put(destination, &name, &value)?;
        }
        self.connection
            .execute("DELETE FROM records WHERE scope=?", [source])?;
        self.put(
            preference,
            "selectedInstallation",
            &serde_json::json!({"installDir":path}),
        )?;
        let mut preferences = self
            .get(preference, "preferences")?
            .unwrap_or_else(|| serde_json::json!({}));
        preferences["confirmedInstallDir"] = serde_json::json!(path);
        self.put(preference, "preferences", &preferences)?;
        transaction.commit()?;
        Ok(())
    }
    pub fn put_scoped(&self, values: &[(String, String, Value)]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for (scope, name, value) in values {
            self.put(scope, name, value)?;
        }
        transaction.commit()?;
        Ok(())
    }
    pub fn put_many(&self, scope: &str, values: &[(&str, Value)]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for (name, value) in values {
            self.put(scope, name, value)?;
        }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discards_only_damaged_verification_cache() {
        let directory = tempfile::tempdir().unwrap();
        let key = [4; 32];
        let store = Store::open(directory.path(), &key).unwrap();
        store
            .put("launcher", "settings", &serde_json::json!({"lang":"na_id"}))
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO records VALUES('game:test','verifyCache','damaged')",
                [],
            )
            .unwrap();
        drop(store);
        let store = Store::open(directory.path(), &key).unwrap();
        assert_eq!(
            store.get("launcher", "settings").unwrap().unwrap()["lang"],
            "na_id"
        );
        assert!(store.get("game:test", "verifyCache").unwrap().is_none());
        store
            .connection
            .execute(
                "UPDATE records SET value='damaged' WHERE name='settings'",
                [],
            )
            .unwrap();
        drop(store);
        assert!(Store::open(directory.path(), &key).is_err());
    }
}
