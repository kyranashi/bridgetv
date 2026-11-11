package com.kyranashi.bridgetv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * BridgeTV для Android — экран с общим веб-интерфейсом (assets/www/web/index.html).
 *
 * Что делает нативная часть (как iOS-оболочка ios/src/main.m):
 *   • показывает интерфейс из приложения — работает без компьютера и сервера;
 *   • мост window.TVAndroid (Bridge.java): запросы без CORS и с корнями Let's Encrypt для старых
 *     Android, сохранение данных в файлы, «не гасить экран», загрузки фильмов;
 *   • кнопка «Назад» (и пульт ТВ) — назад по экранам приложения, на главном — выход;
 *   • полноэкранное видео (onShowCustomView);
 *   • на Android < 7.1 (нет корня ISRG X1) разрешает HTTPS-трансляции только с сертификатами
 *     Let's Encrypt (Bridge.isLetsEncrypt) — остальные ошибки сертификатов отклоняются.
 */
public class MainActivity extends Activity {
    private WebView web;
    private FrameLayout root;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0B0E14);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0E14);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(false);   // отладка WebView выключена
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setLoadWithOverviewMode(true);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.addJavascriptInterface(new Bridge(this, web), "TVAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("file:///android_asset/")) return false;
                if (Bridge.isWeb(url)) openExternal(url);   // внешние ссылки (только http/https) — в браузере
                return true;
            }
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                if (Build.VERSION.SDK_INT < 25 && Bridge.isLetsEncrypt(error.getCertificate())) handler.proceed();
                else handler.cancel();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view; customCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
            }
            @Override
            public void onHideCustomView() { hideCustomView(); }
        });
        web.loadUrl("file:///android_asset/www/web/index.html");
    }

    void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
    }

    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        if (customCallback != null) customCallback.onCustomViewHidden();
        customCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (customView != null) { hideCustomView(); return; }
        // «Назад» по экранам приложения; на главном экране — выход
        web.evaluateJavascript("(window.TV&&TV.app&&TV.app.back())?1:0", new ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if (!"1".equals(v)) MainActivity.super.onBackPressed();
            }
        });
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
