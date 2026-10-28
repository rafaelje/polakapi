pub(super) const MAX_PATH_LEN: usize = 4096;

pub(super) fn validate_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("path is empty".to_string());
    }
    if raw.len() > MAX_PATH_LEN {
        return Err(format!("path is longer than {MAX_PATH_LEN} bytes"));
    }
    if raw.contains('\0') {
        return Err(format!("path contains a NUL byte: {raw:?}"));
    }
    if raw.starts_with('-') {
        return Err(format!("path may not start with '-': {raw}"));
    }
    if raw.starts_with('/') || raw.starts_with('\\') || has_drive_prefix(raw) {
        return Err(format!("path must be relative: {raw}"));
    }
    if raw.split(['/', '\\']).any(|component| component == "..") {
        return Err(format!("path may not contain '..': {raw}"));
    }
    Ok(raw.to_string())
}

pub(super) fn pathspec(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("no paths given".to_string());
    }
    let mut args = vec!["--".to_string()];
    for path in paths {
        args.push(validate_path(path)?);
    }
    Ok(args)
}

pub(super) fn literal_pathspec(paths: &[String]) -> Result<Vec<String>, String> {
    let mut spec = pathspec(paths)?;
    for path in spec.iter_mut().skip(1) {
        *path = format!(":(literal){path}");
    }
    Ok(spec)
}

fn has_drive_prefix(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(test)]
mod tests;
