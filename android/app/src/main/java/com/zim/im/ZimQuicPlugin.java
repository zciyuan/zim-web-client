package com.zim.im;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import tech.kwik.core.QuicClientConnection;
import tech.kwik.core.QuicStream;

/**
 * Raw QUIC transport for the Android app.
 *
 * The gate's `transport=quic` listener speaks TLS 1.3 + ALPN `due-quic` and
 * carries the ZIM frame stream on one bidirectional QUIC stream. Kwik is a pure
 * Java QUIC implementation, so it works in an Android WebView host without a
 * native NDK dependency.
 */
@CapacitorPlugin(name = "ZimQuic")
public class ZimQuicPlugin extends Plugin {
    private static final byte[] HEARTBEAT = {0, 0, 0, 7, 1, 0, 0, 0, 0, 0, 0};
    private static final int CONNECT_TIMEOUT_MS = 10_000;

    private static final class QuicConn {
        QuicClientConnection connection;
        QuicStream stream;
        InputStream input;
        OutputStream output;
        Thread reader;
        ScheduledFuture<?> heartbeat;
    }

    private final Map<String, QuicConn> connections = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);

    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("id");
        String addr = call.getString("addr");
        String alpn = call.getString("alpn", "due-quic");
        boolean allowInsecure = Boolean.TRUE.equals(call.getBoolean("allowInsecure", false));
        if (id == null || id.isEmpty() || addr == null || addr.isEmpty()) {
            call.reject("QUIC id/addr is required");
            return;
        }
        String host;
        int port;
        try {
            int colon = addr.lastIndexOf(':');
            if (colon <= 0) throw new IllegalArgumentException("missing port");
            host = addr.substring(0, colon);
            if (host.startsWith("[") && host.endsWith("]")) {
                host = host.substring(1, host.length() - 1);
            }
            port = Integer.parseInt(addr.substring(colon + 1));
        } catch (Exception error) {
            call.reject("invalid QUIC addr: " + addr);
            return;
        }

        final String qHost = host;
        final int qPort = port;

        new Thread(() -> {
            try {
                QuicClientConnection.Builder builder = QuicClientConnection.newBuilder()
                        .host(qHost)
                        .port(qPort)
                        .applicationProtocol(alpn)
                        .connectTimeout(Duration.ofSeconds(10));
                if (allowInsecure) builder.noServerCertificateCheck();
                QuicClientConnection connection = builder.build();
                connection.connect();
                QuicStream stream = connection.createStream(true);

                QuicConn conn = new QuicConn();
                conn.connection = connection;
                conn.stream = stream;
                conn.input = stream.getInputStream();
                conn.output = stream.getOutputStream();
                // Announce the bidirectional stream before the first ZIM frame.
                synchronized (conn.output) {
                    conn.output.write(HEARTBEAT);
                    conn.output.flush();
                }
                connections.put(id, conn);
                startReader(id, conn);
                conn.heartbeat = scheduler.scheduleAtFixedRate(() -> {
                    QuicConn live = connections.get(id);
                    if (live == null) return;
                    try {
                        synchronized (live.output) {
                            live.output.write(HEARTBEAT);
                            live.output.flush();
                        }
                    } catch (Exception error) {
                        closeConnection(id, 1006, String.valueOf(error));
                    }
                }, 15, 15, TimeUnit.SECONDS);
                call.resolve();
            } catch (Exception error) {
                call.reject("QUIC connect failed: " + error);
            }
        }, "zim-quic-connect").start();
    }

    private void startReader(String id, QuicConn conn) {
        conn.reader = new Thread(() -> {
            byte[] buffer = new byte[16 * 1024];
            try {
                int read;
                while ((read = conn.input.read(buffer)) >= 0) {
                    if (read == 0) continue;
                    JSObject payload = new JSObject();
                    payload.put("id", id);
                    payload.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
                    notifyListeners("quicData", payload);
                }
            } catch (Exception ignored) {
                // fall through to close notification
            }
            closeConnection(id, 1006, "QUIC stream closed");
        }, "zim-quic-reader-" + id);
        conn.reader.start();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        QuicConn conn = id == null ? null : connections.get(id);
        if (conn == null || data == null) {
            call.reject("QUIC connection not found");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            synchronized (conn.output) {
                conn.output.write(bytes);
                conn.output.flush();
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("QUIC write failed: " + error);
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        if (id != null) closeConnection(id, 1000, "closed");
        call.resolve();
    }

    private void closeConnection(String id, int code, String reason) {
        QuicConn conn = connections.remove(id);
        if (conn == null) return;
        if (conn.heartbeat != null) conn.heartbeat.cancel(false);
        try {
            conn.stream.getInputStream().close();
        } catch (Exception ignored) {
            // already closed
        }
        try {
            conn.stream.getOutputStream().close();
        } catch (Exception ignored) {
            // already closed
        }
        try {
            conn.connection.close();
        } catch (Exception ignored) {
            // already closed
        }
        JSObject payload = new JSObject();
        payload.put("id", id);
        payload.put("code", code);
        payload.put("reason", reason);
        notifyListeners("quicClosed", payload);
    }

    @Override
    protected void handleOnDestroy() {
        for (String id : connections.keySet().toArray(new String[0])) {
            closeConnection(id, 1000, "activity destroyed");
        }
        scheduler.shutdownNow();
        super.handleOnDestroy();
    }
}
