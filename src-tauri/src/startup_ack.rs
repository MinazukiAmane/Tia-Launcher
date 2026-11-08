use anyhow::Result;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use anyhow::bail;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::io::Write;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(target_os = "linux", target_os = "macos"))]
static SENT: AtomicBool = AtomicBool::new(false);

pub fn acknowledge() -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let Some(nonce) = std::env::var_os("TIA_MIGRATION_NONCE") else {
            return Ok(());
        };
        let nonce = nonce
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid migration nonce"))?;
        if nonce.len() != 64
            || !nonce
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            bail!("Invalid migration nonce")
        }
        if SENT.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let result = (|| -> Result<()> {
            let socket = std::env::var_os("TIA_MIGRATION_SOCKET")
                .ok_or_else(|| anyhow::anyhow!("Missing migration socket"))?;
            let mut pipe = std::os::unix::net::UnixStream::connect(socket)?;
            writeln!(
                pipe,
                "{}",
                serde_json::json!({"protocol":1,"nonce":nonce,"status":"ready"})
            )?;
            pipe.flush()?;
            Ok(())
        })();
        if result.is_err() {
            SENT.store(false, Ordering::SeqCst);
        }
        return result;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Ok(())
}
