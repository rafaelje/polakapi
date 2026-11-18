use super::{is_json_content_type, Broker};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn request(port: u16, token: &str, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let bytes = body
        .map(|value| serde_json::to_vec(&value).unwrap())
        .unwrap_or_default();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
    stream.write_all(&bytes).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap()
        + 4;
    let header = String::from_utf8_lossy(&response[..split]);
    let status = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let payload = &response[split..];
    let value = if payload.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(payload).unwrap()
    };
    (status, value)
}

#[test]
fn broker_starts_disabled_and_authenticates_every_route() {
    let broker = Broker::start().unwrap();
    let token = broker.register("pane-a", "window-a");
    assert_eq!(request(broker.port(), "bad", "GET", "/peers", None).0, 401);
    assert_eq!(request(broker.port(), &token, "GET", "/peers", None).0, 403);
    broker.configure(true, false);
    assert_eq!(request(broker.port(), "bad", "GET", "/peers", None).0, 401);
    assert_eq!(request(broker.port(), &token, "GET", "/peers", None).0, 200);
    assert!(is_json_content_type("application/a2a+json"));
    assert!(is_json_content_type("application/json; charset=utf-8"));
    assert!(!is_json_content_type("text/plain"));
}

#[test]
fn peers_are_scoped_and_exclude_the_requesting_pane() {
    let broker = Broker::start().unwrap();
    broker.configure(true, false);
    let token_a = broker.register("pane-a", "window-a");
    let _token_b = broker.register("pane-b", "window-a");
    let _token_c = broker.register("pane-c", "window-b");
    let (status, peers) = request(broker.port(), &token_a, "GET", "/peers", None);
    assert_eq!(status, 200);
    assert_eq!(
        peers["peers"],
        json!([{ "id": "pane-b", "window": "window-a" }])
    );
    broker.configure(true, true);
    let (_, peers) = request(broker.port(), &token_a, "GET", "/peers", None);
    assert_eq!(peers["peers"].as_array().unwrap().len(), 2);
}

#[test]
fn send_returns_a_receipt_and_peer_authored_text_is_received_once() {
    let broker = Broker::start().unwrap();
    broker.configure(true, false);
    let token_a = broker.register("pane-a", "window-a");
    let token_b = broker.register("pane-b", "window-a");
    let message = json!({ "message": { "messageId": "m-1", "role": "ROLE_USER", "parts": [{ "text": "Please inspect the API" }] } });
    let (status, receipt) = request(
        broker.port(),
        &token_a,
        "POST",
        "/agents/pane-b/message:send",
        Some(message.clone()),
    );
    assert_eq!(status, 200);
    assert_eq!(receipt["message"]["role"], "ROLE_AGENT");
    assert!(receipt["message"]["parts"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Delivery receipt"));
    assert!(receipt["message"]["parts"][0]["text"]
        .as_str()
        .unwrap()
        .contains("not a peer-authored reply"));
    let (_, inbox) = request(broker.port(), &token_b, "GET", "/inbox", None);
    assert_eq!(inbox["messages"][0]["from"], "pane-a");
    assert_eq!(
        inbox["messages"][0]["message"]["parts"][0]["text"],
        "Please inspect the API"
    );
    assert_eq!(
        inbox["messages"][0]["message"]["contextId"],
        receipt["message"]["contextId"]
    );
    assert_eq!(
        request(broker.port(), &token_b, "GET", "/inbox", None).1["messages"],
        json!([])
    );

    let peer_reply = json!({ "message": { "messageId": "m-2", "role": "ROLE_USER", "parts": [{ "text": "The API returns a JSON object." }] } });
    let (_, peer_receipt) = request(
        broker.port(),
        &token_b,
        "POST",
        "/agents/pane-a/message:send",
        Some(peer_reply),
    );
    assert!(peer_receipt["message"]["parts"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Delivery receipt"));
    let (_, received_reply) = request(broker.port(), &token_a, "GET", "/inbox", None);
    assert_eq!(received_reply["messages"][0]["from"], "pane-b");
    assert_eq!(
        received_reply["messages"][0]["message"]["parts"][0]["text"],
        "The API returns a JSON object."
    );
    assert_eq!(
        received_reply["messages"][0]["message"]["contextId"],
        peer_receipt["message"]["contextId"]
    );
}

#[test]
fn scope_changes_and_window_moves_discard_stale_messages() {
    let broker = Broker::start().unwrap();
    broker.configure(true, true);
    let token_a = broker.register("pane-a", "window-a");
    let token_b = broker.register("pane-b", "window-b");
    let message = json!({ "message": { "messageId": "m-1", "role": "ROLE_USER", "parts": [{ "text": "hello" }] } });
    assert_eq!(
        request(
            broker.port(),
            &token_a,
            "POST",
            "/agents/pane-b/message:send",
            Some(message.clone())
        )
        .0,
        200
    );
    broker.configure(true, false);
    assert_eq!(
        request(broker.port(), &token_b, "GET", "/inbox", None).1["messages"],
        json!([])
    );
    broker.configure(true, true);
    assert_eq!(
        request(
            broker.port(),
            &token_a,
            "POST",
            "/agents/pane-b/message:send",
            Some(message)
        )
        .0,
        200
    );
    broker.move_to("pane-b", "window-c");
    assert_eq!(
        request(broker.port(), &token_b, "GET", "/inbox", None).1["messages"],
        json!([])
    );
}

#[test]
fn rejects_unsupported_parts_and_unknown_targets_and_discovers_card() {
    let broker = Broker::start().unwrap();
    broker.configure(true, true);
    let token_a = broker.register("pane-a", "window-a");
    let _token_b = broker.register("pane-b", "window-b");
    let (_, card) = request(
        broker.port(),
        &token_a,
        "GET",
        "/agents/pane-b/.well-known/agent-card.json",
        None,
    );
    assert_eq!(card["name"], "pane-b");
    assert_eq!(
        card["supportedInterfaces"][0]["protocolBinding"],
        "HTTP+JSON"
    );
    assert_eq!(card["supportedInterfaces"][0]["protocolVersion"], "1.0");
    assert_eq!(card["skills"][0]["id"], "text-messaging");
    let bad = json!({ "message": { "messageId": "m", "role": "ROLE_USER", "parts": [{ "file": { "uri": "file:///etc/passwd" } }] } });
    assert_eq!(
        request(
            broker.port(),
            &token_a,
            "POST",
            "/agents/pane-b/message:send",
            Some(bad)
        )
        .0,
        415
    );
    let good = json!({ "message": { "messageId": "m", "role": "ROLE_USER", "parts": [{ "text": "hello" }] } });
    assert_eq!(
        request(
            broker.port(),
            &token_a,
            "POST",
            "/agents/missing/message:send",
            Some(good)
        )
        .0,
        404
    );
    let unsupported_config = json!({ "message": { "messageId": "m", "role": "ROLE_USER", "parts": [{ "text": "hello" }] }, "configuration": { "blocking": true } });
    assert_eq!(
        request(
            broker.port(),
            &token_a,
            "POST",
            "/agents/pane-b/message:send",
            Some(unsupported_config)
        )
        .0,
        400
    );
}

#[test]
fn context_is_not_readable_without_a_specific_grant() {
    let broker = Broker::start().unwrap();
    broker.configure(true, false);
    let _source = broker.register("source", "window");
    let reviewer = broker.register("reviewer", "window");
    let (code, body) = request(
        broker.port(),
        &reviewer,
        "POST",
        "/review/read",
        Some(json!({"target":"source"})),
    );
    assert_eq!(code, 404);
    assert_eq!(body["error"]["code"], "review_unavailable");
}

#[test]
fn only_the_named_reviewer_reads_the_exact_live_session_until_revoked() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let id = uuid::Uuid::new_v4().to_string();
    let database = root.join("polakapi.db");
    crate::db::agent_session::record_start(&database, "source", "codex", &id, None).unwrap();
    std::fs::create_dir(root.join("sessions")).unwrap();
    let file = root.join("sessions").join(format!("rollout-{id}.jsonl"));
    std::fs::write(&file, format!("{}\n{}\n",json!({"type":"session_meta","payload":{"id":id}}),json!({"type":"event_msg","payload":{"type":"agent_message","message":"unit checks passed"}}))).unwrap();
    let db = rusqlite::Connection::open(root.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL)")
        .unwrap();
    db.execute(
        "INSERT INTO threads VALUES(?1, ?2)",
        (&id, file.canonicalize().unwrap().to_str().unwrap()),
    )
    .unwrap();
    let b = Broker::start().unwrap();
    b.configure(true, false);
    b.register("source", "main");
    let reader = b.register("reader", "main");
    let other = b.register("other", "main");
    let grant = || {
        b.grant_review("source", "reader", &id, database.clone(), root.to_owned())
            .unwrap()
    };
    let page = |token: &str, cursor: Value| {
        request(
            b.port(),
            token,
            "POST",
            "/review/read",
            Some(json!({"target":"source","cursor":cursor})),
        )
    };
    grant();
    assert_eq!(page(&other, Value::Null).0, 404);
    let (status, first) = page(&reader, Value::Null);
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["entries"][0]["text"], "unit checks passed");
    let cursor = &first["cursor"];
    assert_eq!(page(&reader, cursor.clone()).1["entries"], json!([]));
    b.revoke_review("source");
    assert_eq!(page(&reader, cursor.clone()).0, 404);
    grant();
    assert_eq!(page(&reader, cursor.clone()).0, 409);
    b.move_to("reader", "other-window");
    assert_eq!(page(&reader, Value::Null).0, 404);
    b.move_to("reader", "main");
    assert_eq!(page(&reader, Value::Null).0, 404);
    grant();
    b.configure(false, false);
    b.configure(true, false);
    assert_eq!(page(&reader, Value::Null).0, 404);
    grant();
    crate::db::agent_session::record_start(
        &database,
        "source",
        "codex",
        &uuid::Uuid::new_v4().to_string(),
        None,
    )
    .unwrap();
    assert_eq!(page(&reader, Value::Null).0, 404);
}
