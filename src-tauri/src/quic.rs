// Native raw QUIC transport for the desktop shell.
//
// The ZIM gate's `transport=quic` listener is a due `network/quic` endpoint:
// TLS 1.3 + ALPN `due-quic`, one bidirectional stream, and the same
// [len4][ver1][op2][seq4] frames as WS/WebTransport. It does not use HTTP, so
// the browser cannot dial it; the Tauri backend does it with quinn and exposes
// the byte stream to the web layer through commands/events.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

const ALPN: &[u8] = b"due-quic";
/// One empty ZIM frame: announces the stream and doubles as the app heartbeat.
const HEARTBEAT: [u8; 11] = [0, 0, 0, 7, 1, 0, 0, 0, 0, 0, 0];

struct QuicHandle {
    endpoint: quinn::Endpoint,
    conn: quinn::Connection,
    send: Arc<Mutex<quinn::SendStream>>,
}

#[derive(Default)]
pub struct QuicManager {
    conns: StdMutex<HashMap<String, QuicHandle>>,
}

#[derive(Clone, Serialize)]
struct ClosedPayload {
    code: u32,
    reason: String,
}

fn tls_config(ca_file: &str) -> Result<rustls::ClientConfig, String> {
    let mut roots = rustls::RootCertStore::empty();
    if !ca_file.trim().is_empty() {
        let file = std::fs::File::open(ca_file)
            .map_err(|err| format!("open CA file failed: {err}"))?;
        let mut reader = std::io::BufReader::new(file);
        for cert in rustls_pemfile::certs(&mut reader) {
            let cert = cert.map_err(|err| format!("read CA cert failed: {err}"))?;
            roots
                .add(cert)
                .map_err(|err| format!("add CA cert failed: {err}"))?;
        }
    } else {
        // Prefer the OS trust store (private/corporate CAs), then Mozilla roots.
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            let _ = roots.add(cert);
        }
        if roots.is_empty() {
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
    }

    let mut tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.to_vec()];
    Ok(tls)
}

async fn send_heartbeat(send: &Arc<Mutex<quinn::SendStream>>) -> Result<(), String> {
    let mut stream = send.lock().await;
    stream
        .write_all(&HEARTBEAT)
        .await
        .map_err(|err| format!("write heartbeat failed: {err}"))
}

/// Opens a raw QUIC connection and one bidirectional stream.
#[tauri::command]
pub async fn quic_connect(
    app: AppHandle,
    manager: State<'_, QuicManager>,
    id: String,
    addr: String,
    server_name: String,
    ca_file: String,
) -> Result<(), String> {
    let remote: SocketAddr = addr
        .parse()
        .map_err(|err| format!("invalid QUIC addr {addr}: {err}"))?;
    let tls = tls_config(&ca_file)?;
    let crypto = quinn::crypto::rustls::QuicClientConfig::try_from(tls)
        .map_err(|err| format!("QUIC TLS config failed: {err}"))?;
    let client_config = quinn::ClientConfig::new(Arc::new(crypto));

    let bind: SocketAddr = "0.0.0.0:0"
        .parse()
        .map_err(|err| format!("invalid bind addr: {err}"))?;
    let mut endpoint = quinn::Endpoint::client(bind)
        .map_err(|err| format!("create QUIC endpoint failed: {err}"))?;
    endpoint.set_default_client_config(client_config);

    let conn = tokio::time::timeout(
        Duration::from_secs(5),
        endpoint
            .connect(remote, &server_name)
            .map_err(|err| format!("QUIC connect failed: {err}"))?,
    )
    .await
    .map_err(|_| "QUIC handshake timeout".to_string())?
    .map_err(|err| format!("QUIC handshake failed: {err}"))?;

    let (send, mut recv) = tokio::time::timeout(Duration::from_secs(5), conn.open_bi())
        .await
        .map_err(|_| "QUIC stream timeout".to_string())?
        .map_err(|err| format!("open QUIC stream failed: {err}"))?;
    let send = Arc::new(Mutex::new(send));
    send_heartbeat(&send).await?;

    if let Ok(mut conns) = manager.conns.lock() {
        if let Some(old) = conns.remove(&id) {
            old.conn.close(0u32.into(), b"replaced");
        }
        conns.insert(
            id.clone(),
            QuicHandle {
                endpoint: endpoint.clone(),
                conn: conn.clone(),
                send: send.clone(),
            },
        );
    }

    // Inbound stream: raw bytes are forwarded as base64; the web layer
    // reassembles ZIM frames exactly like the WebTransport adapter.
    let app_read = app.clone();
    let id_read = id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match recv.read_chunk(usize::MAX, true).await {
                Ok(Some(chunk)) => {
                    let payload = BASE64.encode(chunk.bytes);
                    let _ = app_read.emit(&format!("quic://data/{id_read}"), payload);
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        let closed = ClosedPayload {
            code: 0,
            reason: "stream closed".into(),
        };
        let _ = app_read.emit(&format!("quic://closed/{id_read}"), closed);
    });

    // Application heartbeat: due's gate reaps a session that sends no frames.
    let app_hb = app.clone();
    let id_hb = id.clone();
    let conn_hb = conn.clone();
    let send_hb = send.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if send_heartbeat(&send_hb).await.is_err() {
                        break;
                    }
                }
                _ = conn_hb.closed() => break,
            }
        }
        let _ = app_hb.emit(
            &format!("quic://closed/{id_hb}"),
            ClosedPayload { code: 0, reason: "connection closed".into() },
        );
    });

    Ok(())
}

/// Sends one frame (base64) on the connection's bidirectional stream.
#[tauri::command]
pub async fn quic_send(
    manager: State<'_, QuicManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let bytes = BASE64
        .decode(data)
        .map_err(|err| format!("decode QUIC payload failed: {err}"))?;
    let send = {
        let conns = manager
            .conns
            .lock()
            .map_err(|_| "QUIC state poisoned".to_string())?;
        conns
            .get(&id)
            .map(|handle| handle.send.clone())
            .ok_or_else(|| format!("QUIC connection {id} not found"))?
    };
    let mut stream = send.lock().await;
    stream
        .write_all(&bytes)
        .await
        .map_err(|err| format!("QUIC write failed: {err}"))
}

/// Closes a connection and releases the endpoint.
#[tauri::command]
pub fn quic_close(manager: State<'_, QuicManager>, id: String) -> Result<(), String> {
    let handle = manager
        .conns
        .lock()
        .map_err(|_| "QUIC state poisoned".to_string())?
        .remove(&id);
    if let Some(handle) = handle {
        handle.conn.close(0u32.into(), b"closed");
        handle.endpoint.close(0u32.into(), b"closed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in against a running raw-QUIC gate:
    ///   ZIM_QUIC_TEST_ADDR=127.0.0.1:12004 \
    ///   ZIM_QUIC_TEST_CA=E:/.../certs/dev-cert.pem \
    ///   cargo test --manifest-path src-tauri/Cargo.toml dials_due_quic -- --nocapture
    #[tokio::test]
    async fn dials_due_quic() {
        let Ok(addr) = std::env::var("ZIM_QUIC_TEST_ADDR") else {
            return;
        };
        let ca = std::env::var("ZIM_QUIC_TEST_CA").unwrap_or_default();
        let remote: SocketAddr = addr.parse().expect("valid test addr");
        let tls = tls_config(&ca).expect("TLS config");
        let crypto = quinn::crypto::rustls::QuicClientConfig::try_from(tls).expect("QUIC crypto");
        let mut endpoint = quinn::Endpoint::client("0.0.0.0:0".parse().unwrap()).expect("endpoint");
        endpoint.set_default_client_config(quinn::ClientConfig::new(Arc::new(crypto)));
        let conn = endpoint
            .connect(remote, "127.0.0.1")
            .expect("connect")
            .await
            .expect("handshake");
        let (mut send, _recv) = conn.open_bi().await.expect("open stream");
        send.write_all(&HEARTBEAT).await.expect("write heartbeat");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(conn.close_reason().is_none(), "gate closed the raw QUIC session");
        conn.close(0u32.into(), b"test done");
        endpoint.wait_idle().await;
    }
}

