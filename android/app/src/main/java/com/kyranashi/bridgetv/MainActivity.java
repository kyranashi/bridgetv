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
    /** Канал из «Продолжить» Android TV (bridgetv://play/<id>) — интерфейс забирает его при запуске (Bridge.startCh) */
    volatile String pendingCh;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        pendingCh = WatchNext.channelFrom(getIntent());
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

    /** Приложение уже открыто, а на главном экране ТВ нажали «Продолжить» — сразу включить канал */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String c = WatchNext.channelFrom(intent);
        if (c != null && web != null)
            web.evaluateJavascript("TV.nativeEvent&&TV.nativeEvent('open',{\"ch\":" + org.json.JSONObject.quote(c) + "})", null);
    }

    // ------------------------------------------------------------------ голосовой поиск (1.0.0)
    private static final int REQ_VOICE = 41;

    /** Системное окно распознавания речи (на Android TV — кнопка микрофона пульта работает так же) */
    void startVoice() {
        Intent i = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "ru-RU");
        i.putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Что найти?");
        i.putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try { startActivityForResult(i, REQ_VOICE); }
        catch (Exception e) { voiceResult(null, "нет распознавания речи"); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_VOICE) return;
        java.util.ArrayList<String> r = data != null ? data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS) : null;
        if (res == RESULT_OK && r != null && !r.isEmpty()) voiceResult(r.get(0), null);
        else voiceResult(null, null);
    }

    private void voiceResult(String text, String err) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            if (text != null) o.put("text", text.length() > 200 ? text.substring(0, 200) : text);
            if (err != null) o.put("err", err);
            web.evaluateJavascript("TV.nativeEvent&&TV.nativeEvent('voice'," + o.toString() + ")", null);
        } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ окно сайта YouTube (1.4.0)
    // Без ключа API приложение не может само искать на YouTube, поэтому поиск и видео открываются на самом
    // сайте YouTube — в отдельном окне поверх приложения (как окно на ПК). Окно изолировано: без моста
    // TVAndroid, без доступа к файлам; переходы — только по адресам YouTube и входа Google, остальное — в браузер.
    private android.app.Dialog ytDialog;
    private WebView ytWeb;

    static boolean ytAllowed(String url) {
        try {
            Uri u = Uri.parse(url);
            String h = u.getHost();
            if (h == null || !"https".equals(u.getScheme())) return false;
            h = h.toLowerCase(java.util.Locale.ROOT);
            return h.equals("youtube.com") || h.endsWith(".youtube.com") || h.equals("youtu.be")
                    || h.equals("accounts.google.com") || h.equals("consent.google.com") || h.equals("www.google.com");
        } catch (Exception e) { return false; }
    }

    @SuppressLint("SetJavaScriptEnabled")
    void openYouTube(String url) {
        if (!ytAllowed(url)) return;
        if (ytDialog != null && ytWeb != null) { ytWeb.loadUrl(url); ytDialog.show(); return; }
        final FrameLayout box = new FrameLayout(this);
        box.setBackgroundColor(0xFF0F0F0F);
        ytWeb = new WebView(this);
        WebSettings s = ytWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        if (Build.VERSION.SDK_INT >= 16) { s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false); }
        ytWeb.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String u) {
                if (ytAllowed(u)) return false;
                if (Bridge.isWeb(u)) openExternal(u);      // чужие ссылки — в обычном браузере
                return true;
            }
        });
        ytWeb.setWebChromeClient(new WebChromeClient() {
            private View full;
            private CustomViewCallback cb;
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {       // видео на весь экран
                if (full != null) { callback.onCustomViewHidden(); return; }
                full = view; cb = callback;
                box.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                ytWeb.setVisibility(View.GONE);
            }
            @Override
            public void onHideCustomView() {
                if (full == null) return;
                box.removeView(full); full = null;
                ytWeb.setVisibility(View.VISIBLE);
                if (cb != null) cb.onCustomViewHidden();
                cb = null;
            }
        });
        box.addView(ytWeb, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ytDialog = new android.app.Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        ytDialog.setContentView(box);
        // «Назад»: по страницам YouTube, а с первой — закрыть окно и вернуться в BridgeTV
        ytDialog.setOnKeyListener(new android.content.DialogInterface.OnKeyListener() {
            @Override
            public boolean onKey(android.content.DialogInterface d, int code, android.view.KeyEvent e) {
                if (code != android.view.KeyEvent.KEYCODE_BACK || e.getAction() != android.view.KeyEvent.ACTION_UP) return false;
                if (ytWeb.canGoBack()) ytWeb.goBack(); else { ytWeb.loadUrl("about:blank"); d.dismiss(); }
                return true;
            }
        });
        ytDialog.show();
        ytWeb.loadUrl(url);
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
    @Override protected void onDestroy() {
        if (ytDialog != null) ytDialog.dismiss();
        if (ytWeb != null) ytWeb.destroy();
        web.destroy();
        super.onDestroy();
    }
}
