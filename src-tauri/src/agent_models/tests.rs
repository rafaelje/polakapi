use super::*;

fn ids(models: &[ModelOption]) -> Vec<&str> {
    models.iter().map(|model| model.id.as_str()).collect()
}

#[test]
fn claude_aliases_come_from_the_model_flag_help() {
    let help = "Options:\n  --fallback-model <model>              Enable automatic fallback to 'x y'\n  \
        --model <model>                       Model for the current session. Provide\n                                        \
        an alias for the latest model (e.g.\n                                        \
        'fable', 'opus', or 'sonnet') or a\n                                        \
        model's full name.\n  -n, --name <name>                     Set a display name for 'this'\n";

    let models = parse_claude_help(help).unwrap();

    assert_eq!(ids(&models), ["fable", "opus", "sonnet"]);
}

#[test]
fn claude_without_a_model_flag_is_an_error() {
    assert!(parse_claude_help("Usage: claude [options]\n").is_err());
}

#[test]
fn codex_lists_visible_models_by_priority() {
    let json = r#"{"models":[
        {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":2},
        {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","priority":1},
        {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","priority":1}
    ]}"#;

    let models = parse_codex_catalog(json).unwrap();

    assert_eq!(ids(&models), ["gpt-6.1-sol", "gpt-6-astra"]);
    assert_eq!(models[0].label, "GPT-6.1-Sol");
}

#[test]
fn cursor_models_are_parsed_from_its_listing() {
    let text = strip_ansi(
        "\u{1b}[1mAvailable models\u{1b}[0m\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\n\
         claude-opus-5-thinking-high - Claude Opus 5 1M Thinking\n\nTip: use --model <id>\n",
    );

    let models = parse_cursor_models(&text).unwrap();

    assert_eq!(
        ids(&models),
        ["auto", "gpt-5.3-codex", "claude-opus-5-thinking-high"]
    );
    assert_eq!(models[0].label, "Auto (default)");
}

#[test]
fn opencode_models_are_provider_slash_model_lines() {
    let models =
        parse_opencode_models("anthropic/claude-sonnet-5\nopencode/glm-5\n\nsome note\n").unwrap();

    assert_eq!(
        ids(&models),
        ["anthropic/claude-sonnet-5", "opencode/glm-5"]
    );
}

#[test]
fn an_empty_listing_is_an_error() {
    assert!(parse_cursor_models("Available models\n").is_err());
    assert!(parse_codex_catalog(r#"{"models":[]}"#).is_err());
}
