package com.kyranashi.bridgetv;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.os.Build;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Socket;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * Мост JavaScript ↔ Android (window.TVAndroid). Тот же набор команд, что у iOS-оболочки:
 *   info()  — {platform:'android', app, os, sdk, model, fileBase} (синхронно)
 *   saved() — сохранённые данные {ключ: 'JSON-строка'} (синхронно)
 *   postMessage(json):
 *     fetch   {id,url,timeout,method,body} -> TV.nativeCb(id, err, text, status)
 *     save    {key,value}   — файл files/tvstore/<ключ>.json (null — удалить)
 *     awake   {on}          — не гасить экран
 *     open    {url}         — открыть во внешнем приложении
 *     download{id,url}      — скачать mp4 в папку приложения, события TV.nativeEvent('dl', …)
 *     dlDelete{id,file}
 * Запросы идут через свой SSLSocketFactory: TLS 1.2 на Android 4.4 и корни Let's Encrypt
 * (assets/www/web/certs/*.der) для Android < 7.1, где их нет в системе.
 */
public class Bridge {
    private final Activity act;
    private final WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final File storeDir, dlDir;
    private SSLSocketFactory ssl;

    // Промежуточные сертификаты Let's Encrypt (для onReceivedSslError на старых Android)
    private static final Set<String> LE = new HashSet<String>(Arrays.asList(
            "R3", "R10", "R11", "R12", "R13", "R14", "E1", "E5", "E6", "E7", "E8", "E9",
            "YR1", "YR2", "YR3", "YE1", "YE2", "YE3"));

    Bridge(Activity act, WebView web) {
        this.act = act;
        this.web = web;
        storeDir = new File(act.getFilesDir(), "tvstore");
        storeDir.mkdirs();
        File ext = act.getExternalFilesDir(null);
        dlDir = new File(ext != null ? ext : act.getFilesDir(), "downloads");
        dlDir.mkdirs();
        try { ssl = buildSsl(); } catch (Exception e) { ssl = null; }
    }

    static boolean isLetsEncrypt(SslCertificate c) {
        if (c == null || c.getIssuedBy() == null) return false;
        String cn = c.getIssuedBy().getCName(), o = c.getIssuedBy().getOName();
        return (o != null && o.contains("Let's Encrypt")) || (cn != null && LE.contains(cn));
    }

    // ------------------------------------------------------------------ синхронные методы
    @JavascriptInterface
    public String info() {
        try {
            JSONObject o = new JSONObject();
            o.put("platform", "android");
            o.put("app", act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName);
            o.put("os", Build.VERSION.RELEASE);
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("model", Build.MODEL);
            o.put("fileBase", Uri.fromFile(dlDir).toString() + "/");
            return o.toString();
        } catch (Exception e) { return "{\"platform\":\"android\"}"; }
    }

    @JavascriptInterface
    public String saved() {
        JSONObject o = new JSONObject();
        File[] fs = storeDir.listFiles();
        if (fs != null) for (File f : fs) {
            String n = f.getName();
            if (!n.endsWith(".json")) continue;
            try { o.put(n.substring(0, n.length() - 5), readFile(f)); } catch (Exception ignored) { }
        }
        return o.toString();
    }

    // ------------------------------------------------------------------ команды
    /** Безопасность (0.3.0): наружу — только http/https */
    static boolean isWeb(String u) {
        if (u == null || u.length() > 8192) return false;
        String l = u.toLowerCase(java.util.Locale.ROOT);
        return l.startsWith("http://") || l.startsWith("https://");
    }

    @JavascriptInterface
    public void postMessage(String json) {
        if (json == null || json.length() > 200000) return;
        final JSONObject m;
        try { m = new JSONObject(json); } catch (Exception e) { return; }
        String cmd = m.optString("cmd");
        if ("fetch".equals(cmd)) pool.execute(new Runnable() { public void run() { fetch(m); } });
        else if ("save".equals(cmd)) save(m.optString("key"), m.isNull("value") ? null : m.optString("value"));
        else if ("awake".equals(cmd)) awake(m.optBoolean("on"));
        else if ("open".equals(cmd)) { if (isWeb(m.optString("url"))) open(m.optString("url")); }
        else if ("download".equals(cmd) && isWeb(m.optString("url")) && m.optString("id").length() > 0 && m.optString("id").length() <= 2048) new Thread(new Runnable() { public void run() { download(m.optString("id"), m.optString("url")); } }).start();
        else if ("dlDelete".equals(cmd)) { String f = m.optString("file"); if (f.length() > 0) new File(dlDir, new File(f).getName()).delete(); }
    }

    private void fetch(JSONObject m) {
        String id = m.optString("id"), err = null, text = "";
        int code = 0;
        HttpURLConnection c = null;
        try {
            if (!isWeb(m.optString("url"))) throw new java.net.MalformedURLException();
            c = open(new URL(m.optString("url")), Math.max(1000, Math.min(m.optInt("timeout", 15000), 120000)));
            String method = "POST".equals(m.optString("method")) ? "POST" : "GET";
            c.setRequestMethod(method);
            if (!m.isNull("body") && m.optString("body").length() > 0) {
                c.setDoOutput(true);
                OutputStream os = c.getOutputStream();
                os.write(m.optString("body").getBytes("UTF-8"));
                os.close();
            }
            code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            text = in != null ? readStream(in, 32 * 1024 * 1024) : "";
            if (code < 200 || code >= 300) err = "HTTP " + code;
        } catch (java.net.SocketTimeoutException e) {
            err = "таймаут";
        } catch (java.net.UnknownHostException e) {
            err = "нет интернета";
        } catch (javax.net.ssl.SSLException e) {
            err = "сертификат";
        } catch (Exception e) {
            err = "нет связи";
        } finally {
            if (c != null) c.disconnect();
        }
        JSONArray a = new JSONArray();
        a.put(id);
        a.put(err == null ? JSONObject.NULL : err);
        a.put(text);
        a.put(code);
        js("TV.nativeCb.apply(null," + a.toString() + ")");
    }

    private HttpURLConnection open(URL u, int timeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        if (c instanceof HttpsURLConnection && ssl != null) ((HttpsURLConnection) c).setSSLSocketFactory(ssl);
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "BridgeTV-Android/" + Build.VERSION.RELEASE);
        return c;
    }

    private void save(String key, String value) {
        if (key == null || !key.matches("[A-Za-z0-9_-]{1,64}")) return;
        if (value != null && value.length() > 8 * 1024 * 1024) return;
        File f = new File(storeDir, key + ".json");
        if (value == null) { f.delete(); return; }
        try {
            File tmp = new File(storeDir, key + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(value.getBytes("UTF-8"));
            out.close();
            tmp.renameTo(f);
        } catch (Exception ignored) { }
    }

    private void awake(final boolean on) {
        act.runOnUiThread(new Runnable() { public void run() {
            if (on) act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else act.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } });
    }

    private void open(final String url) {
        act.runOnUiThread(new Runnable() { public void run() {
            try { act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
        } });
    }

    private void download(String id, String url) {
        String name = "dl-" + System.currentTimeMillis() + ".mp4";
        File dest = new File(dlDir, name);
        HttpURLConnection c = null;
        try {
            c = open(new URL(url), 60000);
            int code = c.getResponseCode();
            if (code >= 400) throw new Exception("HTTP " + code);
            long size = c.getContentLength();
            InputStream in = c.getInputStream();
            FileOutputStream out = new FileOutputStream(dest);
            byte[] buf = new byte[256 * 1024];
            long got = 0, last = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (now - last > 1000) {     // не чаще раза в секунду
                    last = now;
                    JSONObject e = new JSONObject();
                    e.put("id", id); e.put("got", got);
                    if (size > 0) e.put("size", size);
                    js("TV.nativeEvent&&TV.nativeEvent('dl'," + e.toString() + ")");
                }
            }
            out.close();
            in.close();
            JSONObject e = new JSONObject();
            e.put("id", id); e.put("file", name); e.put("done", true); e.put("size", dest.length()); e.put("got", dest.length());
            js("TV.nativeEvent&&TV.nativeEvent('dl'," + e.toString() + ")");
        } catch (Exception ex) {
            dest.delete();
            try {
                JSONObject e = new JSONObject();
                e.put("id", id); e.put("err", ex instanceof java.net.UnknownHostException ? "нет интернета" : "обрыв загрузки");
                js("TV.nativeEvent&&TV.nativeEvent('dl'," + e.toString() + ")");
            } catch (Exception ignored) { }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------------ вспомогательное
    private void js(final String code) {
        act.runOnUiThread(new Runnable() { public void run() { web.evaluateJavascript(code, null); } });
    }

    /** Прочитать ответ целиком, но не больше max байт (защита от переполнения памяти) */
    private static String readStream(InputStream in, int max) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        try {
            while ((n = in.read(buf)) > 0) {
                b.write(buf, 0, n);
                if (b.size() > max) throw new java.io.IOException("too big");
            }
        } finally { in.close(); }
        return b.toString("UTF-8");
    }

    private static String readFile(File f) throws Exception { return readStream(new FileInputStream(f), 16 * 1024 * 1024); }

    /** SSL: системные корни + корни Let's Encrypt из приложения; TLS 1.2 включён и на Android 4.4 */
    private SSLSocketFactory buildSsl() throws Exception {
        TrustManagerFactory sysF = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        sysF.init((KeyStore) null);
        final X509TrustManager sys = (X509TrustManager) sysF.getTrustManagers()[0];

        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        String[] files = act.getAssets().list("www/web/certs");
        if (files != null) for (String f : files) {
            if (!f.endsWith(".der")) continue;
            InputStream in = act.getAssets().open("www/web/certs/" + f);
            ks.setCertificateEntry(f, cf.generateCertificate(in));
            in.close();
        }
        TrustManagerFactory ownF = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        ownF.init(ks);
        final X509TrustManager own = (X509TrustManager) ownF.getTrustManagers()[0];

        X509TrustManager both = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws java.security.cert.CertificateException { sys.checkClientTrusted(chain, auth); }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws java.security.cert.CertificateException {
                try { sys.checkServerTrusted(chain, auth); } catch (java.security.cert.CertificateException e) { own.checkServerTrusted(chain, auth); }
            }
            public X509Certificate[] getAcceptedIssuers() { return sys.getAcceptedIssuers(); }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{both}, null);
        return new Tls12Factory(ctx.getSocketFactory());
    }

    /** На Android 4.4 TLS 1.2 есть, но выключен по умолчанию — включаем на каждом сокете */
    static class Tls12Factory extends SSLSocketFactory {
        private final SSLSocketFactory d;
        Tls12Factory(SSLSocketFactory d) { this.d = d; }
        private Socket fix(Socket s) {
            if (s instanceof SSLSocket) {
                try { ((SSLSocket) s).setEnabledProtocols(((SSLSocket) s).getSupportedProtocols()); } catch (Exception ignored) { }
            }
            return s;
        }
        @Override public String[] getDefaultCipherSuites() { return d.getDefaultCipherSuites(); }
        @Override public String[] getSupportedCipherSuites() { return d.getSupportedCipherSuites(); }
        @Override public Socket createSocket(Socket s, String host, int port, boolean auto) throws java.io.IOException { return fix(d.createSocket(s, host, port, auto)); }
        @Override public Socket createSocket(String host, int port) throws java.io.IOException { return fix(d.createSocket(host, port)); }
        @Override public Socket createSocket(String host, int port, InetAddress la, int lp) throws java.io.IOException { return fix(d.createSocket(host, port, la, lp)); }
        @Override public Socket createSocket(InetAddress h, int port) throws java.io.IOException { return fix(d.createSocket(h, port)); }
        @Override public Socket createSocket(InetAddress h, int port, InetAddress la, int lp) throws java.io.IOException { return fix(d.createSocket(h, port, la, lp)); }
    }
}
