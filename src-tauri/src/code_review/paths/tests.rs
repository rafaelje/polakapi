use super::*;

#[test]
fn accepts_relative_paths_with_spaces_and_unicode() {
    assert_eq!(validate_path("src/main.rs").unwrap(), "src/main.rs");
    assert_eq!(
        validate_path("with space/ñandú file.md").unwrap(),
        "with space/ñandú file.md"
    );
    assert_eq!(validate_path(".github/ci.yml").unwrap(), ".github/ci.yml");
    assert_eq!(validate_path("a..b/c").unwrap(), "a..b/c");
}

#[test]
fn rejects_empty_and_absolute_paths() {
    assert!(validate_path("").is_err());
    assert!(validate_path("/etc/passwd").is_err());
    assert!(validate_path("\\server\\share").is_err());
    assert!(validate_path("C:\\Windows").is_err());
    assert!(validate_path("C:/Windows").is_err());
}

#[test]
fn rejects_parent_traversal() {
    assert!(validate_path("..").is_err());
    assert!(validate_path("../outside").is_err());
    assert!(validate_path("src/../../outside").is_err());
    assert!(validate_path("src\\..\\outside").is_err());
}

#[test]
fn rejects_option_like_and_oversized_paths() {
    assert!(validate_path("-rf").is_err());
    assert!(validate_path("--output=x").is_err());
    assert!(validate_path(&"a".repeat(MAX_PATH_LEN + 1)).is_err());
    assert!(validate_path(&"a".repeat(MAX_PATH_LEN)).is_ok());
    assert!(validate_path("bad\0name").is_err());
}

#[test]
fn pathspec_places_every_path_after_the_separator() {
    let paths = vec!["a b.txt".to_string(), "dir/c.txt".to_string()];
    assert_eq!(
        pathspec(&paths).unwrap(),
        vec!["--", "a b.txt", "dir/c.txt"]
    );
    assert!(pathspec(&["ok".to_string(), "../no".to_string()]).is_err());
    assert!(pathspec(&[]).is_err());
}
