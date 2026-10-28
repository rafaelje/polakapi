use super::*;
use crate::code_review::test_repo::TestRepo;

fn repo_with_report(name: &str, body: &str) -> TestRepo {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "-c", "feat/x"]);
    let dir = repo.path().join("docs/code-review/feat~x");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(name), body).unwrap();
    repo
}

#[test]
fn reads_a_process_report_and_its_pseudo_code() {
    let repo = repo_with_report("1.1-login.html", "<h1>login</h1>");
    let dir = repo.path().join("docs/code-review/feat~x");
    fs::write(dir.join("1.1-login.md"), "# pseudo").unwrap();

    assert_eq!(
        read_report_sync(&repo.path_str(), "1.1-login.html").unwrap(),
        "<h1>login</h1>"
    );
    assert_eq!(
        read_report_sync(&repo.path_str(), "1.1-login.md").unwrap(),
        "# pseudo"
    );
}

#[test]
fn reads_the_index() {
    let repo = repo_with_report("index.html", "<ul></ul>");

    assert_eq!(
        read_report_sync(&repo.path_str(), "index.html").unwrap(),
        "<ul></ul>"
    );
}

#[test]
fn refuses_anything_outside_the_review_folder() {
    let repo = repo_with_report("1.1-login.html", "ok");

    for name in [
        "1.1-../../../a.txt",
        "1.1-..\\a.md",
        "../a.txt",
        "a.txt",
        "notes.html",
        ".1-x.html",
        "",
    ] {
        assert!(read_report_sync(&repo.path_str(), name).is_err(), "{name}");
    }
}

#[cfg(unix)]
#[test]
fn refuses_a_symlinked_report() {
    let repo = repo_with_report("1.1-login.html", "ok");
    let dir = repo.path().join("docs/code-review/feat~x");
    std::os::unix::fs::symlink(repo.path().join("a.txt"), dir.join("1.2-leak.md")).unwrap();

    assert!(read_report_sync(&repo.path_str(), "1.2-leak.md").is_err());
}
