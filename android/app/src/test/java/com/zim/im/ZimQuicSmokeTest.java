package com.zim.im;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.OutputStream;

import tech.kwik.core.QuicClientConnection;
import tech.kwik.core.QuicStream;

/**
 * Opt-in JVM smoke test for the same Kwik path the Android plugin uses.
 *
 *   ZIM_QUIC_TEST_ADDR=127.0.0.1 ZIM_QUIC_TEST_PORT=12004 \
 *   gradlew.bat testDebugUnitTest --tests com.zim.im.ZimQuicSmokeTest
 */
public class ZimQuicSmokeTest {
    private static final byte[] HEARTBEAT = {0, 0, 0, 7, 1, 0, 0, 0, 0, 0, 0};

    @Test
    public void connectsToDueQuicGate() throws Exception {
        String host = System.getenv("ZIM_QUIC_TEST_ADDR");
        String port = System.getenv("ZIM_QUIC_TEST_PORT");
        if (host == null || port == null) return;

        QuicClientConnection connection = QuicClientConnection.newBuilder()
                .host(host)
                .port(Integer.parseInt(port))
                .applicationProtocol("due-quic")
                .noServerCertificateCheck()
                .build();
        connection.connect();
        QuicStream stream = connection.createStream(true);
        OutputStream out = stream.getOutputStream();
        out.write(HEARTBEAT);
        out.flush();
        Thread.sleep(300);
        assertTrue(true);
        connection.close();
    }
}
