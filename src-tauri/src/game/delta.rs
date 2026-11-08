use anyhow::{Context, Result, bail};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
fn integer(bytes: &[u8]) -> Result<i64> {
    if bytes.len() != 8 {
        bail!("Invalid patch integer.")
    }
    let mut magnitude = 0u64;
    for (i, b) in bytes.iter().enumerate() {
        magnitude |= ((if i == 7 { b & 127 } else { *b }) as u64) << (i * 8)
    }
    let value = i64::try_from(magnitude)?;
    Ok(if bytes[7] & 128 != 0 { -value } else { value })
}
pub fn apply(
    old: &Path,
    delta: &Path,
    output: &Path,
    expected: u64,
    control: &super::Control,
) -> Result<()> {
    let mut header = [0u8; 32];
    let mut source = File::open(delta)?;
    source.read_exact(&mut header)?;
    if &header[..8] != b"BSDIFF40" {
        bail!("Unsupported game patch format.")
    }
    let ctrl_len = u64::try_from(integer(&header[8..16])?)?;
    let diff_len = u64::try_from(integer(&header[16..24])?)?;
    let new_len = u64::try_from(integer(&header[24..32])?)?;
    if new_len != expected {
        bail!("Patch size does not match the verified manifest.")
    }
    let diff_offset = 32u64.checked_add(ctrl_len).context("Invalid patch block")?;
    let extra_offset = diff_offset
        .checked_add(diff_len)
        .context("Invalid patch block")?;
    if extra_offset > source.metadata()?.len() {
        bail!("The game patch is incomplete.")
    }
    let block = |offset, length| -> Result<_> {
        let mut f = File::open(delta)?;
        f.seek(SeekFrom::Start(offset))?;
        Ok(bzip2::read::BzDecoder::new(f.take(length)))
    };
    let mut controls = block(32, ctrl_len)?;
    let mut differences = block(diff_offset, diff_len)?;
    let mut extras = block(extra_offset, source.metadata()?.len() - extra_offset)?;
    let mut old = File::open(old)?;
    let old_len = old.metadata()?.len() as i128;
    let mut output = File::create(output)?;
    let mut old_pos = 0i128;
    let mut new_pos = 0u64;
    let mut triples = 0;
    let mut bytes = vec![0u8; 256 * 1024];
    let mut old_bytes = vec![0u8; 256 * 1024];
    while new_pos < new_len {
        control.check()?;
        triples += 1;
        if triples > 1_000_000 {
            bail!("Patch control data is too large.")
        }
        let mut control_bytes = [0u8; 24];
        controls.read_exact(&mut control_bytes)?;
        let x = u64::try_from(integer(&control_bytes[..8])?)?;
        let y = u64::try_from(integer(&control_bytes[8..16])?)?;
        let z = integer(&control_bytes[16..])?;
        if new_pos
            .checked_add(x)
            .and_then(|n| n.checked_add(y))
            .is_none_or(|n| n > new_len)
        {
            bail!("Patch writes beyond the verified file size.")
        }
        let mut done = 0;
        while done < x {
            control.check()?;
            let n = (x - done).min(bytes.len() as u64) as usize;
            differences.read_exact(&mut bytes[..n])?;
            old_bytes[..n].fill(0);
            let at = old_pos + done as i128;
            let left = 0i128.max(-at).min(n as i128) as usize;
            let right = (n as i128).min(old_len - at).max(0) as usize;
            if right > left {
                old.seek(SeekFrom::Start(u64::try_from(at + left as i128)?))?;
                old.read_exact(&mut old_bytes[left..right])?;
            }
            for i in 0..n {
                bytes[i] = bytes[i].wrapping_add(old_bytes[i]);
            }
            output.write_all(&bytes[..n])?;
            done += n as u64;
        }
        new_pos += x;
        old_pos += x as i128;
        let mut done = 0;
        while done < y {
            control.check()?;
            let n = (y - done).min(bytes.len() as u64) as usize;
            extras.read_exact(&mut bytes[..n])?;
            output.write_all(&bytes[..n])?;
            done += n as u64;
        }
        new_pos += y;
        old_pos += z as i128;
    }
    output.flush()?;
    Ok(())
}
