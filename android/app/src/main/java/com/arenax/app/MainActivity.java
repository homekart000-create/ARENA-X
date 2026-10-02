package com.arenax.app;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            // Production API sessions use Secure, SameSite=None cookies across the app/API origins.
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }
    }
}
