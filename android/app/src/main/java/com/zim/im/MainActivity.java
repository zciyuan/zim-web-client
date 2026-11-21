package com.zim.im;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ZimQuicPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
