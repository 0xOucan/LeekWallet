//! JSON-RPC proxy (T62 stage 2).
//!
//! RPC calls originate here rather than in the webview, because the CSP
//! governs the webview and not this process. That is the whole mechanism, and
//! it is what makes a user-supplied endpoint reachable at all: its origin
//! cannot be in a build-time allowlist, so no `connect-src` entry can ever
//! cover it. See docs/RPC-ACCESS.md.
//!
//! The frontend gains no new reach from this. It can call one command we
//! wrote, which does one thing. The alternative — widening `connect-src` to
//! any `https:` origin — would hand arbitrary network reach to the least
//! trustworthy part of the application, and it is not recoverable once code
//! depends on it.
//!
//! # What this owes, having taken the allowlist's job
//!
//! * **https only.** A plaintext RPC lets anyone on the path lie about nonce,
//!   gas price and balance, which is enough to get a bad transaction signed by
//!   an honest user.
//! * **No redirect off the host that was asked for**, and none to another
//!   scheme. A redirect is the obvious way to turn "call this endpoint" into
//!   "post these addresses somewhere else", and it would arrive from the
//!   network rather than from the caller.
//! * **Caps** on request size, response size and time. A wallet must not be
//!   wedged by a node that answers slowly forever, nor by one that answers
//!   with a gigabyte.
//! * **JSON-RPC only.** Both directions are validated as a JSON-RPC envelope
//!   and nothing else, no caller-supplied headers or methods are honoured, and
//!   a non-2xx response body is discarded rather than returned. This must
//!   never become a general-purpose fetch, and every one of those rules exists
//!   to keep it from drifting into one.
//! * **The origin actually used is returned**, so the UI can say who learned
//!   which addresses were asked about. That sentence is already on the sign
//!   preview and it has to stay true.
//!
//! # What is at stake, and what is not
//!
//! An RPC **cannot move funds**: the device signs the fields it rendered, and
//! it re-serialises and re-hashes them itself (PROTOCOL.md section 1). A
//! hostile or broken endpoint can lie about nonce, gas price and balance —
//! pushing the user into a stuck or overpriced transaction — and it learns
//! which addresses are being asked about. Reliability and privacy, not
//! custody. That is why letting a user supply their own endpoint is acceptable
//! at all, and why it still has to be visible.
//!
//! # Why the network half is behind a cargo feature
//!
//! Making an HTTPS request from Rust means a TLS stack, and every available
//! one (rustls with either aws-lc-rs or ring, or native-tls with OpenSSL)
//! builds C for the target. That needs the Android NDK toolchain, which the
//! Android target is not guaranteed to have to hand — `cargo check --target
//! aarch64-linux-android` must keep working for everyone. So `reqwest` is an
//! optional dependency behind `rpc-proxy`, and this module compiles either
//! way: the policy below — which is the reviewable part, and the part with
//! tests — is always built, and without the feature the command answers with a
//! refusal the frontend understands and falls back from.

use serde::Serialize;

/// 64 KiB. Far above any real JSON-RPC call (a large `eth_sendRawTransaction`
/// is a few KiB) and far below anything worth using this command to upload.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// 2 MiB. Above any answer the app asks for, below a response that could be
/// used to push a large blob into the webview through a JSON-RPC-shaped hole.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
pub const MIN_TIMEOUT_MS: u64 = 1_000;
/// A cap, not a suggestion: the caller cannot ask to wait forever.
pub const MAX_TIMEOUT_MS: u64 = 30_000;

/// Two hops. Enough for the http→https and bare-domain→www shuffles a real
/// endpoint may do, and short enough that a redirect chain is not a loop.
pub const MAX_REDIRECTS: usize = 2;

/// A method name long enough for anything real (`eth_getTransactionReceipt` is
/// 26) and short enough that this is not a channel.
const MAX_METHOD_LEN: usize = 64;

/// What comes back from a successful call.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpcReply {
    /// HTTP status. The frontend's failover policy decides what it means.
    pub status: u16,
    /// The JSON-RPC response body, or empty when the status was not 2xx.
    pub body: String,
    /// The origin that actually served this, after any redirect. Displayed.
    pub origin: String,
}

/// Reject a URL this command will not fetch.
///
/// Returns the parsed URL so the caller cannot re-parse a *different* string
/// than the one that was checked — the classic way a validated URL stops being
/// the one that gets used.
pub fn validate_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("not a URL: {e}"))?;

    if parsed.scheme() != "https" {
        // The only rule here that a user might want relaxed, and the one that
        // must not be: over plaintext, anyone on the path can rewrite the
        // nonce and the fees.
        return Err(format!("only https is allowed, not {}", parsed.scheme()));
    }
    match parsed.host_str() {
        None => return Err("URL has no host".into()),
        Some(h) if h.is_empty() => return Err("URL has an empty host".into()),
        Some(_) => {}
    }
    // Credentials in the URL would be sent to a third party as an
    // Authorization header, and `user@host` is also the oldest trick for
    // making a URL look like it points somewhere it does not.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL must not contain credentials".into());
    }
    Ok(parsed)
}

/// `scheme://host[:port]` — what the UI shows as "who was asked".
pub fn origin_of(url: &url::Url) -> String {
    match url.port() {
        Some(p) => format!("{}://{}:{}", url.scheme(), url.host_str().unwrap_or(""), p),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")),
    }
}

/// May a redirect from `from` to `to` be followed?
///
/// Only within the same host, and only to https. A redirect is instruction
/// from the network, not from the caller: honouring a cross-host one would
/// mean the addresses in this request go to a party the user never chose, and
/// would quietly undo every check above.
pub fn redirect_allowed(from: &url::Url, to: &url::Url) -> bool {
    to.scheme() == "https"
        && to.host_str().is_some()
        && to.host_str() == from.host_str()
        && to.port_or_known_default() == from.port_or_known_default()
}

/// Refuse anything that is not a single JSON-RPC 2.0 request.
///
/// Strict about the shape on purpose. Every field the command will forward is
/// one it has understood, so this cannot be pointed at an arbitrary endpoint
/// with an arbitrary payload — which is the difference between a JSON-RPC
/// proxy and a general-purpose fetch with extra steps.
///
/// Batches are refused too: the app does not send them, and an array is a way
/// to pack many calls (and much more data) into one validated request.
pub fn validate_request_body(body: &str) -> Result<(), String> {
    if body.len() > MAX_REQUEST_BYTES {
        return Err(format!(
            "request body is {} bytes, over the {MAX_REQUEST_BYTES} byte limit",
            body.len()
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("request body is not JSON: {e}"))?;
    let obj = value
        .as_object()
        .ok_or("request body must be a single JSON-RPC object, not an array or scalar")?;

    for key in obj.keys() {
        if !matches!(key.as_str(), "jsonrpc" | "id" | "method" | "params") {
            return Err(format!("unexpected field in JSON-RPC request: {key}"));
        }
    }

    if obj.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0") {
        return Err("request must declare jsonrpc 2.0".into());
    }

    let method = obj
        .get("method")
        .and_then(serde_json::Value::as_str)
        .ok_or("request has no method")?;
    if method.is_empty() || method.len() > MAX_METHOD_LEN {
        return Err(format!("implausible method name of {} bytes", method.len()));
    }
    if !method
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(format!("method name is not a JSON-RPC method: {method}"));
    }

    // An id is required, because the reply is matched against it: a response
    // that cannot be tied to its request is one the frontend must not accept.
    match obj.get("id") {
        Some(serde_json::Value::Number(_)) | Some(serde_json::Value::String(_)) => {}
        _ => return Err("request must carry a number or string id".into()),
    }

    match obj.get("params") {
        None | Some(serde_json::Value::Array(_)) | Some(serde_json::Value::Object(_)) => {}
        Some(_) => return Err("params must be an array or an object".into()),
    }

    Ok(())
}

/// Refuse a response that is not a JSON-RPC reply.
///
/// The return path needs its own check: without it, this command hands the
/// webview whatever bytes an arbitrary host chose to send, which is the same
/// general-purpose fetch by a different route. An error page with a 200 is the
/// common honest case; the hostile case is the interesting one.
pub fn validate_response_body(body: &str) -> Result<(), String> {
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "response is {} bytes, over the {MAX_RESPONSE_BYTES} byte limit",
            body.len()
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("response is not JSON: {e}"))?;
    let obj = value
        .as_object()
        .ok_or("response is not a single JSON-RPC object")?;
    if !obj.contains_key("result") && !obj.contains_key("error") {
        return Err("response has neither result nor error".into());
    }
    Ok(())
}

/// Clamp the caller's timeout into a range this process is willing to wait.
pub fn clamp_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/// Does this build have the HTTP client compiled in?
///
/// A capability query rather than something the frontend infers from the
/// presence of an `invoke` bridge — the same rule as `transports()`. Answering
/// "yes" here is a claim that `rpc_call` will actually make a request, and a
/// custom chain offered on a build that cannot reach it is exactly the kind of
/// lie a wallet UI must not tell.
#[tauri::command]
pub fn rpc_proxy_available() -> bool {
    cfg!(feature = "rpc-proxy")
}

/// POST a JSON-RPC request to an endpoint the webview is not allowed to reach.
///
/// Errors are strings because every one of them is either a refusal to show
/// the user or a transport failure the frontend fails over from; there is no
/// case where the frontend wants to branch on a code.
#[tauri::command]
pub async fn rpc_call(
    url: String,
    body: String,
    timeout_ms: Option<u64>,
) -> Result<RpcReply, String> {
    let target = validate_url(&url)?;
    validate_request_body(&body)?;
    let timeout = clamp_timeout_ms(timeout_ms);
    send(target, body, timeout).await
}

#[cfg(not(feature = "rpc-proxy"))]
async fn send(_target: url::Url, _body: String, _timeout_ms: u64) -> Result<RpcReply, String> {
    // Deliberately a plain refusal after the validation above, not before it:
    // the frontend gets the same answer for a bad URL whether or not the
    // client is compiled in, so a build without the feature cannot be used to
    // discover which URLs the policy would have accepted.
    Err("proxy-unavailable: this build has no HTTP client (feature `rpc-proxy` is off)".into())
}

#[cfg(feature = "rpc-proxy")]
async fn send(target: url::Url, body: String, timeout_ms: u64) -> Result<RpcReply, String> {
    use std::time::Duration;

    let start = target.clone();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        // Redirects are decided here rather than by the default policy, which
        // would happily follow one to another host.
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            if redirect_allowed(&start, attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        // No ambient identity travels to a public node: it could only serve to
        // link requests to each other and to this user.
        .user_agent("leekwallet-companion")
        .build()
        .map_err(|e| format!("could not build an HTTP client: {e}"))?;

    let response = client
        .post(target.clone())
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    // The origin *actually* reached: a same-host redirect can still change the
    // port, and what gets displayed must be where the request ended up.
    let origin = origin_of(response.url());
    let status = response.status().as_u16();

    if !response.status().is_success() {
        // The body of a non-2xx is not a JSON-RPC answer, and forwarding it
        // would make this a way to read arbitrary pages. The status is all the
        // frontend needs to fail over.
        return Ok(RpcReply { status, body: String::new(), origin });
    }

    // Cheap pre-check on the advertised length, so an oversized body is
    // refused before it is downloaded rather than after.
    if let Some(len) = response.content_length() {
        if len > MAX_RESPONSE_BYTES as u64 {
            return Err(format!("response advertises {len} bytes, over the limit"));
        }
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("could not read the response: {e}"))?;
    validate_response_body(&text)?;

    Ok(RpcReply { status, body: text, origin })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).expect("test URL")
    }

    #[test]
    fn only_https_is_accepted() {
        assert!(validate_url("https://rpc.example.com").is_ok());
        assert!(validate_url("https://rpc.example.com:8545/path?x=1").is_ok());
        for bad in [
            "http://rpc.example.com",
            "ftp://rpc.example.com",
            "file:///etc/passwd",
            "data:application/json,{}",
            "javascript:alert(1)",
            "ws://rpc.example.com",
            "not a url",
            "",
        ] {
            assert!(validate_url(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn credentials_in_a_url_are_refused() {
        assert!(validate_url("https://user:pw@rpc.example.com").is_err());
        assert!(validate_url("https://user@rpc.example.com").is_err());
    }

    #[test]
    fn the_origin_reported_is_scheme_host_and_port() {
        assert_eq!(origin_of(&u("https://a.example.com/x")), "https://a.example.com");
        assert_eq!(origin_of(&u("https://a.example.com:8545/x")), "https://a.example.com:8545");
    }

    #[test]
    fn redirects_may_not_leave_the_host_or_the_scheme() {
        let from = u("https://a.example.com/rpc");
        assert!(redirect_allowed(&from, &u("https://a.example.com/other")));
        assert!(!redirect_allowed(&from, &u("https://b.example.com/rpc")));
        assert!(!redirect_allowed(&from, &u("http://a.example.com/rpc")));
        // A subdomain is a different host, and "evil.com/?a.example.com" style
        // lookalikes are exactly what a redirect would be used for.
        assert!(!redirect_allowed(&from, &u("https://sub.a.example.com/rpc")));
        assert!(!redirect_allowed(&from, &u("https://a.example.com.evil.test/rpc")));
        // Same host, different port is still somewhere else.
        assert!(!redirect_allowed(&from, &u("https://a.example.com:8545/rpc")));
        // The default port spelled out is the same place.
        assert!(redirect_allowed(&from, &u("https://a.example.com:443/rpc")));
    }

    #[test]
    fn a_well_formed_request_passes() {
        assert!(validate_request_body(
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}"#
        )
        .is_ok());
        // params may be absent, and an object is legal JSON-RPC too.
        assert!(validate_request_body(r#"{"jsonrpc":"2.0","id":"a","method":"eth_chainId"}"#).is_ok());
        assert!(validate_request_body(
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_call","params":{"to":"0x1"}}"#
        )
        .is_ok());
    }

    #[test]
    fn only_json_rpc_gets_through() {
        for bad in [
            // Not JSON at all.
            "hello",
            "",
            // Not an object.
            "[]",
            "\"x\"",
            // A batch: not something the app sends, and a way to pack many
            // calls into one validated request.
            r#"[{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}]"#,
            // Missing or wrong envelope.
            r#"{"id":1,"method":"eth_chainId"}"#,
            r#"{"jsonrpc":"1.0","id":1,"method":"eth_chainId"}"#,
            r#"{"jsonrpc":"2.0","id":1}"#,
            // No id: the reply could not be matched to this request.
            r#"{"jsonrpc":"2.0","method":"eth_chainId"}"#,
            r#"{"jsonrpc":"2.0","id":null,"method":"eth_chainId"}"#,
            // A smuggled extra field is a field nobody validated.
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","headers":{"cookie":"x"}}"#,
            // Method names that are not methods.
            r#"{"jsonrpc":"2.0","id":1,"method":""}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth chainId"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"../../admin"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId\r\nX-Evil: 1"}"#,
            // params must be structured.
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":"all of them"}"#,
        ] {
            assert!(validate_request_body(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn an_oversized_request_is_refused_before_it_is_sent() {
        let big = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["{}"]}}"#,
            "a".repeat(MAX_REQUEST_BYTES)
        );
        assert!(validate_request_body(&big).is_err());
        // And a long method name is not a way around the shape rules.
        let long_method = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"{}"}}"#,
            "m".repeat(MAX_METHOD_LEN + 1)
        );
        assert!(validate_request_body(&long_method).is_err());
    }

    #[test]
    fn only_a_json_rpc_reply_comes_back() {
        assert!(validate_response_body(r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#).is_ok());
        assert!(validate_response_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"reverted"}}"#
        )
        .is_ok());
        for bad in [
            "<html>Sign in to the hotel wifi</html>",
            "",
            "[]",
            r#"{"jsonrpc":"2.0","id":1}"#,
        ] {
            assert!(validate_response_body(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn an_oversized_response_is_refused() {
        let big = format!(r#"{{"id":1,"result":"{}"}}"#, "a".repeat(MAX_RESPONSE_BYTES));
        assert!(validate_response_body(&big).is_err());
    }

    #[test]
    fn the_timeout_is_the_callers_wish_and_our_bounds() {
        assert_eq!(clamp_timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout_ms(Some(5_000)), 5_000);
        // A caller cannot ask to wait forever, nor to give up instantly.
        assert_eq!(clamp_timeout_ms(Some(0)), MIN_TIMEOUT_MS);
        assert_eq!(clamp_timeout_ms(Some(u64::MAX)), MAX_TIMEOUT_MS);
    }

    #[tokio::test]
    async fn a_refused_url_never_reaches_the_network() {
        // Whether or not the client is compiled in, the refusal is the policy's
        // and it names the reason.
        let err = rpc_call(
            "http://plaintext.example.com".into(),
            r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}"#.into(),
            None,
        )
        .await
        .expect_err("plaintext accepted");
        assert!(err.contains("https"), "unhelpful refusal: {err}");

        let err = rpc_call(
            "https://rpc.example.com".into(),
            "not json".into(),
            None,
        )
        .await
        .expect_err("non-JSON accepted");
        assert!(err.contains("JSON"), "unhelpful refusal: {err}");
    }
}
