pub mod archive;
pub mod delta;
pub mod engine;
pub mod launch;
pub mod macos;
pub mod manage;
pub mod model;
pub mod policy;
pub mod predownload;
pub mod runtime;
pub mod transfer;
pub mod verify;
use anyhow::{Result, bail};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;
#[derive(Default)]
pub struct Control {
    pub busy: AtomicBool,
    pub running: AtomicBool,
    cancel: AtomicBool,
    notification: Notify,
}
pub struct Operation(Arc<Control>);
impl Drop for Operation {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}
#[derive(Debug)]
pub struct Paused;
impl std::fmt::Display for Paused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Download paused.")
    }
}
impl std::error::Error for Paused {}
impl Control {
    pub fn acquire(self: &Arc<Self>) -> Result<Operation> {
        if self.running.load(Ordering::SeqCst)
            || self
                .busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            bail!("Wait for the current operation or close the game first.")
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(Operation(self.clone()))
    }
    pub fn pause(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.notification.notify_waiters();
    }
    pub fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(Paused.into());
        }
        Ok(())
    }
    pub async fn cancelled(&self) {
        loop {
            let notified = self.notification.notified();
            if self.cancel.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}
pub type Progress = Arc<dyn Fn(&str, u64, u64) + Send + Sync>;
