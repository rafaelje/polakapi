use super::*;

fn parse(html: &str) -> Verdict {
    parse_verdict(html)
}

#[test]
fn reads_go_and_no_go_from_the_meta_tag() {
    assert_eq!(
        parse(r#"<head><meta name="verdict" content="GO"></head>"#),
        Verdict::Go
    );
    assert_eq!(
        parse(r#"<head><meta name="verdict" content="NO-GO"></head>"#),
        Verdict::NoGo
    );
}

#[test]
fn tolerates_attribute_order_quotes_case_and_spacing() {
    for html in [
        r#"<meta content="GO" name="verdict">"#,
        "<meta name='verdict' content='GO' />",
        "<meta name=verdict content=GO>",
        r#"<META NAME="Verdict" CONTENT=" go ">"#,
        "<meta\n  charset=\"utf-8\"\n  name = \"verdict\"\n  content = \"GO\"\n>",
    ] {
        assert_eq!(parse(html), Verdict::Go, "{html}");
    }
    for html in [
        r#"<meta name="verdict" content="no-go">"#,
        r#"<meta name="verdict" content="NO GO">"#,
        r#"<meta name="verdict" content="NOGO">"#,
    ] {
        assert_eq!(parse(html), Verdict::NoGo, "{html}");
    }
}

#[test]
fn skips_other_meta_tags() {
    let html = r#"<meta charset="utf-8"><meta name="description" content="GO">
        <meta name="verdict" content="NO-GO">"#;

    assert_eq!(parse(html), Verdict::NoGo);
}

#[test]
fn missing_or_malformed_verdicts_are_pending() {
    for html in [
        "",
        "<html><head><title>GO</title></head></html>",
        r#"<meta name="verdict">"#,
        r#"<meta name="verdict" content="">"#,
        r#"<meta name="verdict" content="MAYBE">"#,
        r#"<meta name="verdict" content="GO"#,
        r#"<metadata name="verdict" content="GO">"#,
    ] {
        assert_eq!(parse(html), Verdict::Pending, "{html:?}");
    }
}

#[test]
fn reads_only_the_start_of_large_files() {
    let dir = tempfile::tempdir().unwrap();
    let early = dir.path().join("early.html");
    let late = dir.path().join("late.html");
    let padding = "x".repeat(VERDICT_SCAN_BYTES);
    std::fs::write(
        &early,
        format!(r#"<meta name="verdict" content="GO">{padding}"#),
    )
    .unwrap();
    std::fs::write(
        &late,
        format!(r#"{padding}<meta name="verdict" content="GO">"#),
    )
    .unwrap();

    assert_eq!(read_verdict(&early), Verdict::Go);
    assert_eq!(read_verdict(&late), Verdict::Pending);
    assert_eq!(
        read_verdict(&dir.path().join("missing.html")),
        Verdict::Pending
    );
}
