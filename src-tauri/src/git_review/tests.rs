use super::*;

#[test]
fn safe_ref_accepts_common_shapes() {
    assert!(is_safe_git_ref("main"));
    assert!(is_safe_git_ref("origin/main"));
    assert!(is_safe_git_ref("feature/x-y-z"));
    assert!(is_safe_git_ref("HEAD~2"));
    assert!(is_safe_git_ref("v1.2.3"));
}

#[test]
fn safe_ref_rejects_dangerous_shapes() {
    assert!(!is_safe_git_ref(""));
    assert!(!is_safe_git_ref("-x"));
    assert!(!is_safe_git_ref("a..b"));
    assert!(!is_safe_git_ref("with space"));
    assert!(!is_safe_git_ref("a:b"));
    assert!(!is_safe_git_ref(&"x".repeat(300)));
}

#[test]
fn parses_shortstat_shapes() {
    assert_eq!(
        parse_shortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)"),
        (3, 42, 7)
    );
    assert_eq!(
        parse_shortstat(" 1 file changed, 4 insertions(+)"),
        (1, 4, 0)
    );
    assert_eq!(parse_shortstat(""), (0, 0, 0));
}

#[test]
fn truncate_keeps_short_diffs_intact() {
    assert_eq!(truncate_at_line("small\n", 100), "small\n");
}

#[test]
fn normalize_scope_accepts_relative_paths() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("app/Services/Payment")).unwrap();
    std::fs::write(tmp.path().join("app/Services/Payment/foo.php"), "").unwrap();
    let paths = vec![
        "app/Services/Payment".to_string(),
        "./app/Services/Payment/foo.php".to_string(),
        "  ".to_string(), // dropped silently
    ];
    let clean = normalize_scope_paths(tmp.path(), &paths).unwrap();
    assert_eq!(
        clean,
        vec![
            "app/Services/Payment".to_string(),
            "app/Services/Payment/foo.php".to_string(),
        ]
    );
}

#[test]
fn normalize_scope_rejects_traversal_and_absolute() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("app")).unwrap();
    assert!(normalize_scope_paths(tmp.path(), &["../etc".to_string()]).is_err());
    assert!(normalize_scope_paths(tmp.path(), &["/etc/passwd".to_string()]).is_err());
    assert!(normalize_scope_paths(tmp.path(), &["app/../../etc".to_string()]).is_err());
    // Windows-style drive-letter absolutes must be caught in both forms.
    let err_bs =
        normalize_scope_paths(tmp.path(), &["C:\\Windows\\System32".to_string()]).unwrap_err();
    assert!(err_bs.contains("must be relative"), "got: {err_bs}");
    let err_fs =
        normalize_scope_paths(tmp.path(), &["C:/Windows/System32".to_string()]).unwrap_err();
    assert!(err_fs.contains("must be relative"), "got: {err_fs}");
}

#[test]
fn normalize_scope_rejects_missing_paths() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(normalize_scope_paths(tmp.path(), &["does-not-exist".to_string()]).is_err());
}

#[test]
fn normalize_scope_deduplicates_and_normalizes_separators() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("app/Http")).unwrap();
    let paths = vec![
        "app/Http".to_string(),
        "app\\Http".to_string(),
        "app/Http".to_string(),
    ];
    let clean = normalize_scope_paths(tmp.path(), &paths).unwrap();
    assert_eq!(clean, vec!["app/Http".to_string()]);
}

#[test]
fn truncate_cuts_at_line_boundary() {
    let raw = "aaaa\nbbbb\ncccc\ndddd\n";
    let out = truncate_at_line(raw, 10);
    assert_eq!(out, "aaaa\nbbbb\n");
}

#[test]
fn truncate_survives_multibyte_cutoff() {
    // "á" is 2 bytes (0xC3 0xA1). A cutoff mid-char would panic on `text[..n]`.
    let raw = "áááááááááá\nbbb\n";
    // Any max in [0, raw.len()) must not panic.
    for n in 0..raw.len() {
        let _ = truncate_at_line(raw, n);
    }
}

fn make_file_block(path: &str, body_lines: usize) -> String {
    let mut s = format!(
            "diff --git a/{path} b/{path}\nindex aaa..bbb 100644\n--- a/{path}\n+++ b/{path}\n@@ -1,{body_lines} +1,{body_lines} @@\n",
        );
    for i in 0..body_lines {
        s.push_str(&format!(
            "+line {i} — padding padding padding padding padding\n"
        ));
    }
    s
}

#[test]
fn splits_diff_by_file_header() {
    let d = format!(
        "{}{}",
        make_file_block("src/a.ts", 2),
        make_file_block("src/b.ts", 3)
    );
    let parts = split_diff_by_file(&d);
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].0, "src/a.ts");
    assert_eq!(parts[1].0, "src/b.ts");
    assert_eq!(parts.iter().map(|(_, s)| s.as_str()).collect::<String>(), d);
}

#[test]
fn split_handles_deletion() {
    let block = "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n";
    let parts = split_diff_by_file(block);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].0, "gone.txt");
}

#[test]
fn split_handles_no_headers() {
    let parts = split_diff_by_file("random noise\n");
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].0, "");
}

#[test]
fn generated_paths_match_common_noise() {
    assert!(is_generated_path("yarn.lock"));
    assert!(is_generated_path("packages/app/package-lock.json"));
    assert!(is_generated_path("node_modules/react/index.js"));
    assert!(is_generated_path("packages/x/node_modules/dep/foo.ts"));
    assert!(is_generated_path("public/dist/main.js"));
    assert!(is_generated_path("dist/main.js"));
    assert!(is_generated_path("public/js/vendor.min.js"));
    assert!(is_generated_path("src/__snapshots__/Foo.test.ts.snap"));
    assert!(is_generated_path("assets/logo.PNG"));
    assert!(is_generated_path("src/vendor/foo.php"));

    assert!(!is_generated_path("src/foo.ts"));
    assert!(!is_generated_path("app/Http/Controller.php"));
    assert!(!is_generated_path(
        "database/migrations/2026_01_01_add_x.php"
    ));
}

#[test]
fn budgets_drop_generated_and_truncate_large() {
    let mut diff = String::new();
    diff.push_str(&make_file_block("src/small.ts", 5));
    diff.push_str(&make_file_block("yarn.lock", 4));
    diff.push_str(&make_file_block("src/huge.ts", 400)); // ~24k chars
    let scope: Vec<String> = vec![];

    let out = apply_budgets(&diff, &scope, 4_000, 100_000);

    assert_eq!(out.files_excluded, vec!["yarn.lock"]);
    assert_eq!(out.files_truncated, vec!["src/huge.ts"]);
    assert!(out.truncated);
    assert!(!out.diff.contains("yarn.lock"));
    assert!(out.diff.contains("src/small.ts"));
    assert!(out.diff.contains("src/huge.ts: truncated at 4000 bytes"));
}

#[test]
fn budgets_respect_explicit_scope_override() {
    let mut diff = String::new();
    diff.push_str(&make_file_block("yarn.lock", 3));
    let scope = vec!["yarn.lock".to_string()];

    let out = apply_budgets(&diff, &scope, 100_000, 100_000);

    assert!(
        out.files_excluded.is_empty(),
        "explicit scope must override the noise filter"
    );
    assert!(out.diff.contains("yarn.lock"));
}

#[test]
fn budgets_scope_prefix_covers_nested_generated_files() {
    let block = make_file_block("packages/foo/dist/main.js", 2);
    let scope = vec!["packages/foo".to_string()];

    let out = apply_budgets(&block, &scope, 100_000, 100_000);

    assert!(out.files_excluded.is_empty());
    assert!(out.diff.contains("packages/foo/dist/main.js"));
}

#[test]
fn budgets_total_cap_kicks_in_after_per_file() {
    let mut diff = String::new();
    for i in 0..10 {
        diff.push_str(&make_file_block(&format!("src/f{i}.ts"), 40));
    }
    let scope: Vec<String> = vec![];

    // Per-file cap is generous so no per-file trim fires; total cap is tight.
    let out = apply_budgets(&diff, &scope, 100_000, 5_000);

    assert!(out.files_truncated.is_empty());
    assert!(out.truncated);
    assert!(out.diff.contains("diff truncated at 5000 bytes total"));
}
