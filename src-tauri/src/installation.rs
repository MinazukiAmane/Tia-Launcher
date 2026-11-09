#[cfg(any(windows, test))]
use anyhow::Context;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallContext {
    pub directory: String,
    pub scope: Scope,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    CurrentUser,
    AllUsers,
}

pub fn preserve_arguments(args: Vec<String>, context: &InstallContext) -> Result<Vec<String>> {
    ensure!(
        !context.directory.is_empty() && !context.directory.contains(['\"', '\r', '\n', '\0']),
        "Unsupported launcher path"
    );
    let mut args: Vec<_> = args
        .into_iter()
        .filter(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower != "/allusers" && lower != "/currentuser" && !lower.starts_with("/d=")
        })
        .collect();
    args.push(
        match context.scope {
            Scope::AllUsers => "/allusers",
            Scope::CurrentUser => "/currentuser",
        }
        .into(),
    );
    args.push(format!("/D={}", context.directory));
    Ok(args)
}

#[cfg(windows)]
pub fn windows_context(executable: &std::path::Path, guid: &str) -> Result<InstallContext> {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY,
        RRF_SUBKEY_WOW6464KEY, RegGetValueW,
    };
    ensure!(
        guid.len() == 36
            && guid
                .bytes()
                .enumerate()
                .all(|(i, b)| if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }),
        "Invalid installer identity"
    );
    ensure!(
        executable.is_absolute(),
        "Invalid launcher installation path"
    );
    let directory = executable.parent().context("Missing launcher directory")?;
    let expected = normalized(&std::fs::canonicalize(directory)?.to_string_lossy());
    let subkey: Vec<u16> = format!("Software\\{guid}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = "InstallLocation".encode_utf16().chain(Some(0)).collect();
    let mut scopes = std::collections::HashSet::new();
    for (root, scope) in [
        (HKEY_CURRENT_USER, Scope::CurrentUser),
        (HKEY_LOCAL_MACHINE, Scope::AllUsers),
    ] {
        for view in [RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY] {
            let mut buffer = vec![0u16; 32768];
            let mut size = (buffer.len() * 2) as u32;
            let status = unsafe {
                RegGetValueW(
                    root,
                    subkey.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ | view,
                    std::ptr::null_mut(),
                    buffer.as_mut_ptr().cast(),
                    &mut size,
                )
            };
            if status == 2 {
                continue;
            }
            ensure!(
                status == 0 && size >= 2 && size as usize <= buffer.len() * 2 && size % 2 == 0,
                "Windows installation information could not be read"
            );
            let length = buffer
                .iter()
                .position(|n| *n == 0)
                .context("Invalid registry path")?;
            let path = String::from_utf16(&buffer[..length])?;
            if std::fs::canonicalize(path)
                .ok()
                .is_some_and(|p| normalized(&p.to_string_lossy()) == expected)
            {
                scopes.insert(scope);
            }
        }
    }
    let scope = unique_scope(&scopes.into_iter().collect::<Vec<_>>())?;
    Ok(InstallContext {
        directory: without_prefix(&directory.to_string_lossy()),
        scope,
    })
}

#[cfg(any(windows, test))]
fn unique_scope(scopes: &[Scope]) -> Result<Scope> {
    let first = *scopes
        .first()
        .context("The launcher installation scope could not be confirmed")?;
    ensure!(
        scopes.iter().all(|scope| *scope == first),
        "The launcher installation scope is ambiguous"
    );
    Ok(first)
}
#[cfg(any(windows, test))]
fn without_prefix(path: &str) -> String {
    if path
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\UNC\\"))
    {
        format!("\\\\{}", &path[8..])
    } else {
        path.strip_prefix("\\\\?\\").unwrap_or(path).to_owned()
    }
}
#[cfg(any(windows, test))]
fn normalized(path: &str) -> String {
    without_prefix(path).trim_end_matches('\\').to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_ambiguous_or_missing_scope() {
        assert!(unique_scope(&[]).is_err());
        assert!(unique_scope(&[Scope::AllUsers, Scope::CurrentUser]).is_err());
        assert_eq!(
            unique_scope(&[Scope::CurrentUser, Scope::CurrentUser]).unwrap(),
            Scope::CurrentUser
        );
    }
    #[test]
    fn replaces_scope_and_keeps_destination_last() {
        let context = InstallContext {
            directory: "D:\\Custom Folder\\Tia".into(),
            scope: Scope::CurrentUser,
        };
        assert_eq!(
            preserve_arguments(
                vec!["/S".into(), "/ALLUSERS".into(), "/D=C:\\Wrong".into()],
                &context
            )
            .unwrap(),
            vec!["/S", "/currentuser", "/D=D:\\Custom Folder\\Tia"]
        );
        assert_eq!(
            normalized("\\\\?\\UNC\\Server\\Share\\Tia\\"),
            "\\\\server\\share\\tia"
        );
        assert_eq!(without_prefix("\\\\?\\C:\\Custom\\Tia"), "C:\\Custom\\Tia");
        assert!(
            preserve_arguments(
                vec![],
                &InstallContext {
                    directory: "C:\\bad\"arg".into(),
                    scope: Scope::AllUsers
                }
            )
            .is_err()
        );
    }
}
