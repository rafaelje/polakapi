use std::fs;
use std::io::ErrorKind;
use std::path::Path;

/// Discriminated error variants returned by [`validate_path`].
///
/// Each variant maps to a stable string in the frontend contract:
/// - [`PathError::NotFound`]      -> `"not_found"`
/// - [`PathError::NotDirectory`]  -> `"not_directory"`
/// - [`PathError::NotReadable`]   -> `"not_readable"`
/// - [`PathError::Other`]         -> `"unknown:<msg>"`
#[derive(Debug)]
pub enum PathError {
    NotFound,
    NotDirectory,
    NotReadable,
    Other(String),
}

impl PathError {
    /// Stable string form consumed by the frontend `path-validation.ts` wrapper.
    pub fn as_contract_string(&self) -> String {
        match self {
            PathError::NotFound => "not_found".to_string(),
            PathError::NotDirectory => "not_directory".to_string(),
            PathError::NotReadable => "not_readable".to_string(),
            PathError::Other(msg) => format!("unknown:{msg}"),
        }
    }
}

/// Validate that `path` exists, is a directory, and is readable by the current
/// process. Returns a typed [`PathError`] on failure; never panics.
pub fn validate_path(path: &str) -> Result<(), PathError> {
    let p = Path::new(path);

    let metadata = match fs::metadata(p) {
        Ok(m) => m,
        Err(err) => {
            return Err(match err.kind() {
                ErrorKind::NotFound => PathError::NotFound,
                ErrorKind::PermissionDenied => PathError::NotReadable,
                _ => PathError::Other(err.to_string()),
            });
        }
    };

    if !metadata.is_dir() {
        return Err(PathError::NotDirectory);
    }

    // Lightweight readability check: attempt to enumerate the directory. This
    // verifies read+execute permission on the directory without holding any
    // file handle longer than necessary.
    match fs::read_dir(p) {
        Ok(_) => Ok(()),
        Err(err) => Err(match err.kind() {
            ErrorKind::PermissionDenied => PathError::NotReadable,
            ErrorKind::NotFound => PathError::NotFound,
            _ => PathError::Other(err.to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn validates_existing_directory() {
        let tmp = env::temp_dir();
        assert!(validate_path(tmp.to_str().unwrap()).is_ok());
    }

    #[test]
    fn rejects_missing_path() {
        let result = validate_path("/this/path/should/not/exist/xyz123");
        assert!(matches!(result, Err(PathError::NotFound)));
    }

    #[test]
    fn rejects_non_directory() {
        // Cargo guarantees this file exists during test runs.
        let manifest = env!("CARGO_MANIFEST_DIR");
        let file = format!("{manifest}/Cargo.toml");
        let result = validate_path(&file);
        assert!(matches!(result, Err(PathError::NotDirectory)));
    }

    #[test]
    fn error_strings_match_contract() {
        assert_eq!(PathError::NotFound.as_contract_string(), "not_found");
        assert_eq!(
            PathError::NotDirectory.as_contract_string(),
            "not_directory"
        );
        assert_eq!(PathError::NotReadable.as_contract_string(), "not_readable");
        assert_eq!(
            PathError::Other("boom".to_string()).as_contract_string(),
            "unknown:boom"
        );
    }
}
