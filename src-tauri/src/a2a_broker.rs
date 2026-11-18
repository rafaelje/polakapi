mod review;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::net::TcpListener as TokioTcpListener;
use uuid::Uuid;

const MAX_PEERS: usize = 256;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_TEXT_BYTES: usize = 16 * 1024;
const MAX_PARTS: usize = 16;
const MAX_INBOX_MESSAGES: usize = 128;
const RECEIVE_TIMEOUT: Duration = Duration::from_millis(100);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Peer {
    id: String,
    window: String,
    token: String,
    inbox: VecDeque<QueuedMessage>,
}

#[derive(Clone)]
struct QueuedMessage {
    from: String,
    window: String,
    message: Value,
}

struct State {
    enabled: bool,
    all_windows: bool,
    peers: HashMap<String, Peer>,
    grants: HashMap<String, review::Grant>,
    read_slot: Arc<tokio::sync::Semaphore>,
}

impl State {
    fn visible(&self, source: &Peer, target: &Peer) -> bool {
        source.id != target.id && (self.all_windows || source.window == target.window)
    }

    fn clear_inboxes(&mut self) {
        for peer in self.peers.values_mut() {
            peer.inbox.clear();
        }
    }
}

/// In-process, loopback-only A2A broker. A delivery receipt means only that the
/// broker queued the message; peer-authored replies arrive independently in `/inbox`.
pub struct Broker {
    port: u16,
    state: Arc<Mutex<State>>,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Broker {
    pub fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        let state = Arc::new(Mutex::new(State {
            enabled: false,
            all_windows: false,
            peers: HashMap::new(),
            grants: HashMap::new(),
            read_slot: Arc::new(tokio::sync::Semaphore::new(1)),
        }));
        let stopped = Arc::new(AtomicBool::new(false));
        let thread_state = Arc::clone(&state);
        let thread_stopped = Arc::clone(&stopped);
        let worker = thread::Builder::new()
            .name("a2a-loopback-broker".into())
            .spawn(move || {
                runtime.block_on(serve(listener, thread_state, thread_stopped, port));
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            port,
            state,
            stopped,
            worker: Some(worker),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Registers a live pane and rotates any previously-issued bearer token.
    /// Returns an empty token if the bounded peer table is full.
    pub fn register(&self, id: &str, window: &str) -> String {
        if id.is_empty() || id.len() > 208 || window.is_empty() || window.len() > 208 {
            return String::new();
        }
        let mut state = self.state.lock();
        if !state.peers.contains_key(id) && state.peers.len() >= MAX_PEERS {
            return String::new();
        }
        let token = Uuid::new_v4().to_string();
        state.revoke_pane(id);
        state.peers.insert(
            id.to_string(),
            Peer {
                id: id.to_string(),
                window: window.to_string(),
                token: token.clone(),
                inbox: VecDeque::new(),
            },
        );
        token
    }

    pub fn unregister(&self, id: &str) {
        let mut state = self.state.lock();
        state.revoke_pane(id);
        state.peers.remove(id);
        for peer in state.peers.values_mut() {
            peer.inbox.retain(|message| message.from != id);
        }
    }

    pub fn move_to(&self, id: &str, window: &str) {
        if window.is_empty() || window.len() > 208 {
            return;
        }
        let mut state = self.state.lock();
        if state.peers.get(id).is_some_and(|p| p.window != window) {
            state.revoke_pane(id);
        }
        if let Some(peer) = state.peers.get_mut(id) {
            if peer.window != window {
                peer.window = window.to_string();
                peer.inbox.clear();
            }
        }
    }

    pub fn configure(&self, enabled: bool, all_windows: bool) {
        let mut state = self.state.lock();
        if state.enabled != enabled || state.all_windows != all_windows {
            state.clear_inboxes();
            state.grants.clear();
        }
        state.enabled = enabled;
        state.all_windows = all_windows;
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

async fn serve(
    listener: TcpListener,
    shared: Arc<Mutex<State>>,
    stopped: Arc<AtomicBool>,
    port: u16,
) {
    let listener = match TokioTcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(_) => return,
    };
    let mut connections = tokio::task::JoinSet::new();
    while !stopped.load(Ordering::Acquire) {
        tokio::select! {
            _ = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept(), if connections.len() < 8 => {
                let (stream, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(_) => continue,
                };
                let state = Arc::clone(&shared);
                connections.spawn(async move {
                let io = TokioIo::new(stream);
                let service = service_fn(move |request| {
                    let state = Arc::clone(&state);
                    async move { handle_request(request, &state, port).await }
                });
                let connection = hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .serve_connection(io, service);
                let _ = tokio::time::timeout(REQUEST_TIMEOUT, connection).await;
                });
            }
            _ = tokio::time::sleep(RECEIVE_TIMEOUT) => {}
        }
    }
}

async fn handle_request(
    request: Request<Incoming>,
    shared: &Arc<Mutex<State>>,
    port: u16,
) -> Result<Response<Full<Bytes>>, io::Error> {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let authorization = request
        .headers()
        .get(hyper::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if let Err((status, payload)) = preflight(authorization.as_deref(), shared) {
        return Ok(json_response(status, payload));
    }

    let mut body = Vec::new();
    if method == Method::POST {
        let content_type = request
            .headers()
            .get(hyper::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !is_json_content_type(content_type) {
            return Ok(json_response(
                415,
                json!({"error":{"code":"unsupported_content_type","message":"SendMessage requires application/json"}}),
            ));
        }
        let mut incoming = request.into_body();
        while let Some(frame) = incoming.frame().await {
            let frame = match frame {
                Ok(frame) => frame,
                Err(_) => {
                    return Ok(json_response(
                        400,
                        json!({"error":{"code":"invalid_body","message":"Could not read request body"}}),
                    ));
                }
            };
            if let Ok(data) = frame.into_data() {
                if body.len().saturating_add(data.len()) > MAX_BODY_BYTES {
                    return Ok(json_response(
                        413,
                        json!({"error":{"code":"body_too_large","message":"Request body exceeds the limit"}}),
                    ));
                }
                body.extend_from_slice(&data);
            }
        }
    }
    if method == Method::POST && path == "/review/read" {
        let token = authorization
            .as_deref()
            .and_then(|a| a.strip_prefix("Bearer "))
            .unwrap_or_default();
        let (status, body) = review::read(shared, token, &body).await;
        return Ok(json_response(status, body));
    }
    let response = route(method, &path, authorization.as_deref(), &body, shared, port);
    Ok(json_response(response.0, response.1))
}

fn is_json_content_type(content_type: &str) -> bool {
    matches!(
        content_type.split(';').next().map(str::trim),
        Some(media_type)
            if media_type.eq_ignore_ascii_case("application/json")
                || media_type.eq_ignore_ascii_case("application/a2a+json")
    )
}

fn preflight(authorization: Option<&str>, shared: &Mutex<State>) -> Result<(), (u16, Value)> {
    let token = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| error_response(401, "unauthorized", "Bearer token required"))?;
    let state = shared.lock();
    if !state.peers.values().any(|peer| peer.token == token) {
        return Err(error_response(
            401,
            "unauthorized",
            "Invalid or expired bearer token",
        ));
    }
    if !state.enabled {
        return Err(error_response(
            403,
            "disabled",
            "Agent-to-agent messaging is disabled",
        ));
    }
    Ok(())
}

fn json_response(status: u16, payload: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header(
            hyper::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )
        .header(hyper::header::CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::from(
            serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec()),
        )))
        .expect("valid static A2A response headers")
}

fn route(
    method: Method,
    path: &str,
    authorization: Option<&str>,
    body: &[u8],
    shared: &Mutex<State>,
    port: u16,
) -> (u16, Value) {
    let token = match authorization.and_then(|value| value.strip_prefix("Bearer ")) {
        Some(token) if !token.is_empty() => token,
        _ => return error_response(401, "unauthorized", "Bearer token required"),
    };
    let mut state = shared.lock();
    let source_id = match state.peers.values().find(|peer| peer.token == token) {
        Some(peer) => peer.id.clone(),
        None => return error_response(401, "unauthorized", "Invalid or expired bearer token"),
    };
    if !state.enabled {
        return error_response(403, "disabled", "Agent-to-agent messaging is disabled");
    }
    let source = match state.peers.get(&source_id).cloned() {
        Some(peer) => peer,
        None => return error_response(401, "unauthorized", "Pane is no longer registered"),
    };

    if path == "/peers" && method == Method::GET {
        let peers = state
            .peers
            .values()
            .filter(|target| state.visible(&source, target))
            .map(|target| json!({"id": target.id, "window": target.window}))
            .collect::<Vec<_>>();
        return (200, json!({"peers": peers}));
    }
    if path == "/inbox" && method == Method::GET {
        let queued = state
            .peers
            .get_mut(&source_id)
            .map(|peer| peer.inbox.drain(..).collect::<Vec<_>>())
            .unwrap_or_default();
        let messages = queued
            .into_iter()
            .filter(|message| {
                state
                    .peers
                    .get(&message.from)
                    .map(|sender| state.visible(sender, &source) && message.window == source.window)
                    .unwrap_or(false)
            })
            .map(|message| json!({"from": message.from, "message": message.message}))
            .collect::<Vec<_>>();
        return (200, json!({"messages": messages}));
    }

    if let Some(target_id) = card_target(path) {
        if method != Method::GET {
            return error_response(405, "method_not_allowed", "Agent cards require GET");
        }
        let target = match state.peers.get(target_id) {
            Some(target) if state.visible(&source, target) => target,
            _ => {
                return error_response(404, "peer_not_found", "Peer is not available in this scope")
            }
        };
        return (200, agent_card(target, port));
    }

    if let Some(target_id) = send_target(path) {
        if method != Method::POST {
            return error_response(405, "method_not_allowed", "Message send requires POST");
        }
        let request = match parse_text_message(body) {
            Ok(request) => request,
            Err((status, code, detail)) => return error_response(status, code, detail),
        };
        let visible = state
            .peers
            .get(target_id)
            .map(|target| state.visible(&source, target))
            .unwrap_or(false);
        if !visible {
            return error_response(404, "peer_not_found", "Peer is not available in this scope");
        }
        let target = match state.peers.get_mut(target_id) {
            Some(target) => target,
            _ => {
                return error_response(404, "peer_not_found", "Peer is not available in this scope")
            }
        };
        if target.inbox.len() >= MAX_INBOX_MESSAGES {
            return error_response(429, "inbox_full", "Peer inbox is full");
        }
        let target_window = target.window.clone();
        let mut message = request["message"].clone();
        let context_id = message
            .get("contextId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        message["contextId"] = Value::String(context_id.clone());
        let message_id = message["messageId"].as_str().unwrap_or_default().to_owned();
        target.inbox.push_back(QueuedMessage {
            from: source.id,
            window: target_window,
            message,
        });
        let response_message_id = Uuid::new_v4().to_string();
        return (
            200,
            json!({
                "message": {
                    "role": "ROLE_AGENT",
                    "messageId": response_message_id,
                    "contextId": context_id,
                    "parts": [{ "text": format!("Delivery receipt: message {message_id} was queued for pane {target_id}; this is not a peer-authored reply.") }]
                }
            }),
        );
    }

    error_response(404, "not_found", "Unknown A2A route")
}

fn card_target(path: &str) -> Option<&str> {
    path.strip_prefix("/agents/")?
        .strip_suffix("/.well-known/agent-card.json")
}

fn send_target(path: &str) -> Option<&str> {
    path.strip_prefix("/agents/")?.strip_suffix("/message:send")
}

fn parse_text_message(body: &[u8]) -> Result<Value, (u16, &'static str, &'static str)> {
    let request: Value = serde_json::from_slice(body).map_err(|_| {
        (
            400,
            "invalid_message",
            "Request must contain a JSON A2A message",
        )
    })?;
    if request.as_object().map(|object| object.len()) != Some(1) || request.get("message").is_none()
    {
        return Err((
            400,
            "invalid_message",
            "Expected a SendMessageRequest containing only message",
        ));
    }
    let message = &request["message"];
    let allowed_message_fields = ["messageId", "contextId", "parts", "role"];
    if message.as_object().map(|object| {
        object
            .keys()
            .all(|key| allowed_message_fields.contains(&key.as_str()))
    }) != Some(true)
        || message.get("role").and_then(Value::as_str) != Some("ROLE_USER")
        || message
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .is_none()
    {
        return Err((
            400,
            "invalid_message",
            "Expected a ROLE_USER A2A Message with a bounded messageId and no unsupported fields",
        ));
    }
    if message.get("contextId").is_some()
        && message
            .get("contextId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .is_none()
    {
        return Err((
            400,
            "invalid_message",
            "contextId must be a non-empty string of at most 128 bytes",
        ));
    }
    let parts = message
        .get("parts")
        .and_then(Value::as_array)
        .filter(|parts| !parts.is_empty() && parts.len() <= MAX_PARTS)
        .ok_or((
            400,
            "invalid_message",
            "Message must contain between 1 and 16 parts",
        ))?;
    let mut total = 0usize;
    for part in parts {
        if part.as_object().map(|object| object.len()) != Some(1) || part.get("text").is_none() {
            return Err((
                415,
                "unsupported_content",
                "Only A2A text parts are supported",
            ));
        }
        let text = part.get("text").and_then(Value::as_str).ok_or((
            400,
            "invalid_message",
            "Text part requires a string",
        ))?;
        total += text.len();
        if total > MAX_TEXT_BYTES {
            return Err((413, "text_too_large", "Message text exceeds the limit"));
        }
    }
    Ok(request)
}

fn agent_card(peer: &Peer, port: u16) -> Value {
    json!({
        "name": peer.id,
        "description": "polakapi live-pane A2A text endpoint",
        "supportedInterfaces": [{
            "url": format!("http://127.0.0.1:{port}/agents/{}", peer.id),
            "protocolBinding": "HTTP+JSON",
            "protocolVersion": "1.0"
        }],
        "version": "1.0.0",
        "capabilities": { "streaming": false, "pushNotifications": false },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [{
            "id": "text-messaging",
            "name": "Text messaging",
            "description": "Exchange text messages with a live polakapi pane.",
            "tags": ["messaging", "text"],
            "examples": ["Please review this API design."],
            "inputModes": ["text/plain"],
            "outputModes": ["text/plain"]
        }]
    })
}

fn error_response(status: u16, code: &str, detail: &str) -> (u16, Value) {
    (status, json!({"error": {"code": code, "message": detail}}))
}

#[cfg(test)]
mod tests;
