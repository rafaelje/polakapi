use super::*;
use crate::code_review::test_repo::TestRepo;

fn read(repo: &TestRepo, file: &str) -> Result<String, String> {
    report_sync(&repo.path_str(), file)
}

#[test]
fn returns_a_report_from_the_branch_folder() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "-c", "feat/x"]);
    repo.write("docs/code-review/feat-x/1.1-a.html", "<p>report</p>");
    repo.write("docs/code-review/feat-x/index.html", "<p>index</p>");

    assert_eq!(read(&repo, "1.1-a.html").unwrap(), "<p>report</p>");
    assert_eq!(read(&repo, "index.html").unwrap(), "<p>index</p>");
}

#[test]
fn refuses_names_that_leave_the_folder_or_are_not_html() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/other/1.1-a.html", "x");
    repo.write("docs/code-review/main/1.1-a.md", "x");
    repo.write("secret.html", "x");

    for file in [
        "../other/1.1-a.html",
        "../../secret.html",
        "/etc/passwd.html",
        "sub/1.1-a.html",
        "sub\\1.1-a.html",
        "..",
        "1.1-a.md",
        "",
    ] {
        assert!(read(&repo, file).is_err(), "{file:?}");
    }
}

#[cfg(unix)]
#[test]
fn refuses_a_symlink_that_points_outside_the_folder() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("secret.html", "secret");
    repo.write("docs/code-review/main/.keep", "");
    std::os::unix::fs::symlink(
        repo.path().join("secret.html"),
        repo.path().join("docs/code-review/main/1.1-a.html"),
    )
    .unwrap();

    let error = read(&repo, "1.1-a.html").unwrap_err();

    assert!(error.contains("outside"), "{error}");
}

#[test]
fn refuses_oversize_and_missing_reports() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    let big = "x".repeat(MAX_REPORT_BYTES as usize + 1);
    repo.write("docs/code-review/main/1.1-big.html", &big);

    assert!(read(&repo, "1.1-big.html")
        .unwrap_err()
        .contains("too large"));
    assert!(read(&repo, "1.2-missing.html").is_err());
}
