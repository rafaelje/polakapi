use super::*;
use crate::code_review::test_repo::TestRepo;

fn list(repo: &TestRepo) -> ReviewProcesses {
    processes_sync(&repo.path_str()).unwrap()
}

fn names(processes: &ReviewProcesses) -> Vec<String> {
    processes
        .processes
        .iter()
        .map(|process| format!("{}-{}", process.number, process.slug))
        .collect()
}

#[test]
fn an_absent_folder_has_no_processes() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "-c", "feat/x"]);

    let processes = list(&repo);

    assert_eq!(processes.branch, "feat/x");
    assert_eq!(processes.folder, "docs/code-review/feat-x");
    assert!(processes.processes.is_empty());
}

#[test]
fn groups_markdown_and_html_by_process_sorted_numerically() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/main/1.10-late.md", "x");
    repo.write("docs/code-review/main/1.2-login.md", "x");
    repo.write("docs/code-review/main/1.2-login.html", "x");
    repo.write("docs/code-review/main/2.1-sync.html", "x");
    repo.write("docs/code-review/main/1.1-setup.md", "x");

    let processes = list(&repo);

    assert_eq!(
        names(&processes),
        ["1.1-setup", "1.2-login", "1.10-late", "2.1-sync"]
    );
    let login = &processes.processes[1];
    assert_eq!(login.markdown.as_deref(), Some("1.2-login.md"));
    assert_eq!(login.html.as_deref(), Some("1.2-login.html"));
    assert_eq!(processes.processes[3].markdown, None);
}

#[test]
fn ignores_files_outside_the_naming_contract() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    for name in [
        "index.html",
        "notes.md",
        "1.1-.md",
        "a.1-x.md",
        "1..1-x.md",
        "1.1-x.txt",
        "1.1-dir.md/inner.md",
    ] {
        repo.write(&format!("docs/code-review/main/{name}"), "x");
    }
    repo.write("docs/code-review/main/1.1-ok.md", "x");

    assert_eq!(names(&list(&repo)), ["1.1-ok"]);
}

#[test]
fn processes_without_a_report_are_pending() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/main/1.1-a.md", "x");

    assert_eq!(list(&repo).processes[0].verdict, Verdict::Pending);
}

#[test]
fn reads_each_report_verdict_and_the_index() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/main/1.1-a.md", "x");
    repo.write(
        "docs/code-review/main/1.1-a.html",
        r#"<head><meta name="verdict" content="GO"></head>"#,
    );
    repo.write(
        "docs/code-review/main/1.2-b.html",
        r#"<meta content='NO-GO' name='verdict'>"#,
    );
    repo.write("docs/code-review/main/1.3-c.html", "<p>half written");

    let processes = list(&repo);
    let verdicts: Vec<Verdict> = processes.processes.iter().map(|p| p.verdict).collect();

    assert_eq!(verdicts, [Verdict::Go, Verdict::NoGo, Verdict::Pending]);
    assert_eq!(processes.index, None);
    repo.write("docs/code-review/main/index.html", "<p>summary</p>");
    assert_eq!(list(&repo).index.as_deref(), Some("index.html"));
}

#[test]
fn refuses_a_detached_head() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "--detach", "HEAD"]);

    let error = processes_sync(&repo.path_str()).unwrap_err();

    assert!(error.contains("detached"), "{error}");
}
