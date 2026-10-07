package com.termux.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import com.termux.R;

/**
 * Rincy 启动器主界面：底部任务栏（对话 / 设置）+ 大 WebView。
 * 打开应用不再进入 Termux 终端；开发模式下可单独打开终端查看。
 */
public class RincyMainActivity extends Activity {

    private static final int TAB_CHAT = 0;
    private static final int TAB_SETTINGS = 1;

    private RincyPrefs prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private View pageChat;
    private View pageSettings;
    private View navChat;
    private View navSettings;
    private ImageView navChatIcon;
    private ImageView navSettingsIcon;
    private TextView navChatLabel;
    private TextView navSettingsLabel;

    private WebView webView;
    private View chatStatusBox;
    private TextView chatStatusText;
    private TextView chatStatusDetail;

    private TextView statusTitle;
    private TextView statusDetail;
    private Button startStopButton;
    private EditText portInput;
    private RadioGroup modeGroup;
    private Switch autostartSwitch;
    private Button btnUpgrade;
    private RadioGroup upgradeSourceGroup;
    private EditText upgradeUrlInput;
    private TextView upgradeStatusText;
    private View devGroup;
    private TextView devPaths;

    private int currentTab = TAB_CHAT;
    private boolean working = false;
    private int loadedPort = -1;
    private long lastLoadAt = 0L;

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_STORAGE = 1002;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean pageFailed = false;
    private int retryCount = 0;
    private static final int MAX_RETRY = 40;
    private static final long RETRY_INTERVAL_MS = 1500L;

    private final Runnable retryRunnable = new Runnable() {
        @Override
        public void run() {
            retryCount++;
            if (retryCount > MAX_RETRY) {
                pageFailed = false;
                retryCount = 0;
                return;
            }
            if (isFinishing()) return;
            final int port = prefs.getPort();
            if (RincyServer.isServing(port)) {
                retryCount = 0;
                pageFailed = false;
                loadChat(port);
                return;
            }
            if (RincyServer.hasLiveProcess()) {
                startServer(true);
                return;
            }
            if (prefs.isAutostart()) {
                startServer(false);
                return;
            }
            // 仍未启动：让状态栏提示自行重试（已设置按钮），不再自动重试
            pageFailed = false;
            retryCount = 0;
        }
    };

    private final Runnable statusTick = new Runnable() {
        @Override
        public void run() {
            refreshStatus();
            handler.postDelayed(this, 2500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new RincyPrefs(this);
        setContentView(R.layout.activity_rincy_main);
        bindViews();
        setupNavigation();
        setupWebView();
        setupSettings();
        applyMode();
        selectTab(TAB_CHAT);
        refreshStatus();
        handler.postDelayed(statusTick, 2500);
        boot();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        refreshStatus();
        // 回前台时把页面补上：WebView 可能被系统回收成白屏
        ensureChatLoaded();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    /**
     * launchMode=singleTask：从桌面「第二次打开」走的是 onNewIntent，不会重新 onCreate，
     * 之前这里什么都不做，于是 WebView 一直是上次留下的空白页。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        refreshStatus();
        ensureChatLoaded();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            ViewGroup parent = (webView.getParent() instanceof ViewGroup)
                ? (ViewGroup) webView.getParent() : null;
            if (parent != null) parent.removeView(webView);
            try {
                webView.destroy();
            } catch (Throwable ignored) {
            }
            webView = null;
        }
        super.onDestroy();
    }

    /** 服务在跑但页面没加载（白屏 / 端口变了 / 首次进入）时补一次加载。 */
    private void ensureChatLoaded() {
        if (webView == null) return;
        int port = prefs.getPort();
        if (!RincyServer.isServing(port)) return;
        String want = "http://127.0.0.1:" + port + "/";
        String current = webView.getUrl();
        boolean wrongUrl = current == null || !current.startsWith(want);
        // 地址对但内容高度为 0：多半是渲染进程被回收后留下的白屏。
        // 加 3 秒保护，避免刚发起加载就被误判成白屏而重复加载。
        boolean blank = !wrongUrl
            && webView.getContentHeight() <= 0
            && System.currentTimeMillis() - lastLoadAt > 3000;
        if (wrongUrl || blank) {
            loadChat(port);
        }
    }

    @Override
    public void onBackPressed() {
        if (currentTab != TAB_CHAT) {
            selectTab(TAB_CHAT);
            return;
        }
        super.onBackPressed();
    }

    // ------------------------------------------------------------------ 视图绑定

    private void bindViews() {
        pageChat = findViewById(R.id.pageChat);
        pageSettings = findViewById(R.id.pageSettings);
        navChat = findViewById(R.id.navChat);
        navSettings = findViewById(R.id.navSettings);
        navChatIcon = findViewById(R.id.navChatIcon);
        navSettingsIcon = findViewById(R.id.navSettingsIcon);
        navChatLabel = findViewById(R.id.navChatLabel);
        navSettingsLabel = findViewById(R.id.navSettingsLabel);

        webView = findViewById(R.id.webView);
        chatStatusBox = findViewById(R.id.chatStatusBox);
        chatStatusText = findViewById(R.id.chatStatusText);
        chatStatusDetail = findViewById(R.id.chatStatusDetail);

        statusTitle = findViewById(R.id.statusTitle);
        statusDetail = findViewById(R.id.statusDetail);
        startStopButton = findViewById(R.id.startStopButton);
        portInput = findViewById(R.id.portInput);
        modeGroup = findViewById(R.id.modeGroup);
        autostartSwitch = findViewById(R.id.autostartSwitch);
        devGroup = findViewById(R.id.devGroup);
        devPaths = findViewById(R.id.devPaths);
        btnUpgrade = findViewById(R.id.btnUpgrade);
        upgradeSourceGroup = findViewById(R.id.upgradeSourceGroup);
        upgradeUrlInput = findViewById(R.id.upgradeUrlInput);
        upgradeStatusText = findViewById(R.id.upgradeStatusText);
    }

    private void setupNavigation() {
        navChat.setOnClickListener(v -> selectTab(TAB_CHAT));
        navSettings.setOnClickListener(v -> selectTab(TAB_SETTINGS));
    }

    private void selectTab(int tab) {
        currentTab = tab;
        pageChat.setVisibility(tab == TAB_CHAT ? View.VISIBLE : View.GONE);
        pageSettings.setVisibility(tab == TAB_SETTINGS ? View.VISIBLE : View.GONE);

        int accent = getResources().getColor(R.color.rincy_accent);
        int muted = getResources().getColor(R.color.rincy_muted);
        tintNav(navChatIcon, navChatLabel, tab == TAB_CHAT ? accent : muted);
        tintNav(navSettingsIcon, navSettingsLabel, tab == TAB_SETTINGS ? accent : muted);
        navChat.setBackgroundResource(tab == TAB_CHAT ? R.drawable.rincy_nav_item_active : 0);
        navSettings.setBackgroundResource(tab == TAB_SETTINGS ? R.drawable.rincy_nav_item_active : 0);

        if (tab == TAB_SETTINGS) refreshStatus();
    }

    private void tintNav(ImageView icon, TextView label, int color) {
        icon.setColorFilter(color);
        label.setTextColor(color);
    }

    // ------------------------------------------------------------------ 对话页

    /**
     * 注入到页面的下载增强脚本。
     *
     * WebView 原生不支持 blob: 下载，也不支持 window.open 触发的附件下载：
     *   1) 单个智能体导出用 window.open('/api/agents/export?agentId=..')
     *   2) 全部导出用 fetch → blob → 新建 <a download> 并 a.click()
     * 注意第 2 种锚点没有插进 DOM，事件不会冒泡到 document，
     * 因此必须改写 HTMLAnchorElement.prototype.click 才能拦到。
     * 两条路径统一交给原生桥 RincyNative 落盘到「下载」目录。
     */
    private static final String JS_DOWNLOAD_SHIM =
        "(function(){if(window.__rincyDl)return;window.__rincyDl=1;\n" +
        "function saveBlob(href,name){fetch(href).then(function(r){return r.blob();}).then(function(b){\n" +
        "var fr=new FileReader();\n" +
        "fr.onload=function(){var s=String(fr.result);RincyNative.saveBase64(name||'download.bin',s.slice(s.indexOf(',')+1));};\n" +
        "fr.readAsDataURL(b);\n" +
        "}).catch(function(e){RincyNative.toast('导出失败: '+e);});}\n" +
        "function handle(href,name){if(!href)return false;\n" +
        "if(href.indexOf('blob:')===0){saveBlob(href,name);return true;}\n" +
        "if(href.indexOf('/api/agents/export')!==-1){RincyNative.download(href,name||'');return true;}\n" +
        "return false;}\n" +
        "var oc=HTMLAnchorElement.prototype.click;\n" +
        "HTMLAnchorElement.prototype.click=function(){try{\n" +
        "if(handle(this.href||'',this.getAttribute('download')||''))return;}catch(e){}\n" +
        "return oc.apply(this,arguments);};\n" +
        "var ow=window.open;\n" +
        "window.open=function(u){try{if(u&&handle(String(u),''))return null;}catch(e){}\n" +
        "return ow.apply(window,arguments);};\n" +
        "document.addEventListener('click',function(ev){var t=ev.target;\n" +
        "var a=(t&&t.closest)?t.closest('a[download]'):null;if(!a)return;\n" +
        "try{if(handle(a.href||'',a.getAttribute('download')||'')){ev.preventDefault();ev.stopPropagation();}}catch(e){}\n" +
        "},true);})();";

    private void setupWebView() {
        webView = findViewById(R.id.webView);
        configureWebView(webView);
        findViewById(R.id.chatRetryButton).setOnClickListener(v -> {
            hideChatStatus();
            startServer(true);
        });
    }

    /** WebView 的所有配置集中在这里，渲染进程崩溃后重建时也要复用。 */
    private void configureWebView(WebView wv) {
        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        // 导入需要 WebView 能读取文件选择器返回的 content:// 与 file:// URI
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        wv.setBackgroundColor(getResources().getColor(R.color.rincy_bg));
        WebView.setWebContentsDebuggingEnabled(true);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);

        wv.addJavascriptInterface(new RincyNative(), "RincyNative");

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageFailed = false;
                retryCount = 0;
                handler.removeCallbacks(retryRunnable);
                if (loadedPort > 0) hideChatStatus();
                // 每次页面（重新）加载后都重新注入下载增强脚本
                view.evaluateJavascript(JS_DOWNLOAD_SHIM, null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    pageFailed = true;
                    retryCount = 0;
                    scheduleRetry();
                    showChatStatus("正在连接 Rincy…", "服务还没就绪，正在自动重试…", false);
                }
            }

            // 渲染进程被系统回收：重建 WebView 并重新加载，否则页面永远白屏
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                try {
                    rebuildWebView(view);
                } catch (Throwable t) {
                    toast("页面重建失败，请重开本页: " + t.getMessage());
                }
                return true;
            }
        });

        // 导入：<input type="file"> 必须由 WebChromeClient 接管，否则点击无反应
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    String[] accept = params == null ? null : params.getAcceptTypes();
                    if (accept != null && accept.length > 0 && accept[0] != null
                        && !accept[0].isEmpty() && !"*/*".equals(accept[0])) {
                        intent.setType(accept[0]);
                    }
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
                    return true;
                } catch (Throwable t) {
                    filePathCallback = null;
                    toast("无法打开文件选择器: " + t.getMessage());
                    return false;
                }
            }
        });

        // 导出：服务端返回附件的直接下载
        wv.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                saveFromUrl(url, parseFilename(contentDisposition));
            }
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !hasStoragePermission()) {
            requestPermissions(new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, REQ_STORAGE);
        }
    }

    /** 渲染进程崩溃后，用同位置的新 WebView 顶替旧的。 */
    private void rebuildWebView(WebView dead) {
        ViewGroup parent = (dead.getParent() instanceof ViewGroup) ? (ViewGroup) dead.getParent() : null;
        int index = 0;
        ViewGroup.LayoutParams lp = null;
        if (parent != null) {
            index = parent.indexOfChild(dead);
            lp = dead.getLayoutParams();
            parent.removeView(dead);
        }
        try {
            dead.destroy();
        } catch (Throwable ignored) {
        }
        WebView fresh = new WebView(this);
        if (parent != null) {
            parent.addView(fresh, index, lp == null ? new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT) : lp);
        }
        webView = fresh;
        configureWebView(fresh);
        loadedPort = -1;
        showChatStatus("页面已恢复", "正在重新加载…", false);
        ensureChatLoaded();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE_CHOOSER) return;
        if (filePathCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    // ------------------------------------------------------------------ 导出落盘

    /** 页面注入的原生桥：负责把导出内容真正写到「下载」目录。 */
    private class RincyNative {
        @JavascriptInterface
        public void download(String url, String name) {
            saveFromUrl(url, name);
        }

        @JavascriptInterface
        public void saveBase64(String name, String base64) {
            try {
                saveBytes(name, Base64.decode(base64, Base64.DEFAULT));
            } catch (Throwable t) {
                runOnUiThread(() -> toast("保存失败: " + t.getMessage()));
            }
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> RincyMainActivity.this.toast(message));
        }
    }

    private void saveFromUrl(String url, String name) {
        new Thread(() -> {
            try {
                String abs = url;
                if (abs != null && abs.startsWith("/")) {
                    abs = "http://127.0.0.1:" + prefs.getPort() + abs;
                }
                HttpURLConnection conn = (HttpURLConnection) new URL(abs).openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(120000);
                String cookie = CookieManager.getInstance().getCookie(abs);
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                conn.connect();
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("HTTP " + code);
                }
                String fname = name;
                if (fname == null || fname.isEmpty()) {
                    fname = parseFilename(conn.getHeaderField("Content-Disposition"));
                }
                if (fname == null || fname.isEmpty()) fname = guessName(abs);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
                }
                conn.disconnect();
                saveBytes(fname, bos.toByteArray());
            } catch (Throwable t) {
                runOnUiThread(() -> toast("导出失败: " + t.getMessage()));
            }
        }, "rincy-export").start();
    }

    private void saveBytes(String name, byte[] data) {
        if (name == null || name.isEmpty()) name = "rincy-export.bin";
        name = name.replace('/', '_').replace('\\', '_');
        try {
            File dir = null;
            if (hasStoragePermission()) {
                dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            }
            if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) {
                dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            }
            if (dir == null) dir = getFilesDir();
            File out = new File(dir, name);
            try (OutputStream os = new FileOutputStream(out)) {
                os.write(data);
            }
            final String path = out.getAbsolutePath();
            runOnUiThread(() -> toast("已导出: " + path));
        } catch (Throwable t) {
            runOnUiThread(() -> toast("保存失败: " + t.getMessage()));
        }
    }

    private boolean hasStoragePermission() {
        return checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE")
            == PackageManager.PERMISSION_GRANTED;
    }

    private static String parseFilename(String contentDisposition) {
        if (contentDisposition == null) return null;
        try {
            Matcher m = Pattern
                .compile("filename\\*?=(?:UTF-8'')?\"?([^\";]+)\"?", Pattern.CASE_INSENSITIVE)
                .matcher(contentDisposition);
            if (m.find()) return URLDecoder.decode(m.group(1), "UTF-8");
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static String guessName(String url) {
        try {
            String path = new URL(url).getPath();
            int i = path.lastIndexOf('/');
            if (i >= 0 && i + 1 < path.length()) return path.substring(i + 1);
        } catch (Throwable ignored) {
        }
        return "rincy-export.tar";
    }

    private void showChatStatus(String title, String detail, boolean showRetry) {
        chatStatusText.setText(title);
        chatStatusDetail.setText(detail);
        chatStatusDetail.setVisibility(detail == null || detail.isEmpty() ? View.GONE : View.VISIBLE);
        findViewById(R.id.chatRetryButton).setVisibility(showRetry ? View.VISIBLE : View.GONE);
        chatStatusBox.setVisibility(View.VISIBLE);
    }

    private void hideChatStatus() {
        chatStatusBox.setVisibility(View.GONE);
    }

    // ------------------------------------------------------------------ 设置页

    private void setupSettings() {
        portInput.setText(String.valueOf(prefs.getPort()));
        portInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        autostartSwitch.setChecked(prefs.isAutostart());
        modeGroup.check(prefs.isDevMode() ? R.id.modeDev : R.id.modePlayer);

        startStopButton.setOnClickListener(v -> {
            if (isServing()) stopServer();
            else startServer(false);
        });

        findViewById(R.id.portSaveButton).setOnClickListener(v -> savePort());

        modeGroup.setOnCheckedChangeListener((group, checkedId) -> {
            prefs.setMode(checkedId == R.id.modeDev ? RincyPrefs.MODE_DEV : RincyPrefs.MODE_PLAYER);
            applyMode();
        });

        autostartSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> prefs.setAutostart(isChecked));

        findViewById(R.id.btnOpenTermux).setOnClickListener(v -> {
            try {
                startActivity(new Intent(this, TermuxActivity.class));
            } catch (Throwable t) {
                toast("无法打开终端: " + t.getMessage());
            }
        });

        findViewById(R.id.btnViewLog).setOnClickListener(v -> showLog());

        findViewById(R.id.btnRestart).setOnClickListener(v -> startServer(true));

        findViewById(R.id.btnResetEnv).setOnClickListener(v -> confirmReset());
        btnUpgrade.setOnClickListener(v -> runUpgrade());
    }

    private void applyMode() {
        boolean dev = prefs.isDevMode();
        devGroup.setVisibility(dev ? View.VISIBLE : View.GONE);
        if (dev) {
            devPaths.setText(
                "前缀: " + RincyServer.PREFIX + "\n" +
                "源码: " + RincyServer.SOURCE_DIR + "\n" +
                "数据: " + RincyServer.DATA_DIR + "\n" +
                "日志: " + RincyServer.LOG_FILE);
        }
    }

    private void savePort() {
        int port;
        try {
            port = Integer.parseInt(portInput.getText().toString().trim());
        } catch (Throwable t) {
            toast("端口要是数字");
            return;
        }
        if (port < 1024 || port > 65535) {
            toast("端口范围 1024 - 65535");
            return;
        }
        int old = prefs.getPort();
        prefs.setPort(port);
        loadedPort = -1;
        if (port == old) {
            toast("端口没变");
            return;
        }
        toast("端口已改为 " + port);
        if (RincyServer.isServing(old) || isServing()) {
            startServer(true);
        } else {
            refreshStatus();
        }
    }

    // ------------------------------------------------------------------ 服务控制

    private boolean isServing() {
        return RincyServer.isServing(prefs.getPort());
    }

    private void boot() {
        if (!RincyServer.isInstalled()) {
            showChatStatus("正在部署运行环境…", "首次启动需要解包，约 10-30 秒", false);
            RincyServer.ensureBootstrap(this, () -> {
                if (!RincyServer.hasPayload()) {
                    showChatStatus("部署不完整", "缺少 " + RincyServer.BOOT_SCRIPT, false);
                    return;
                }
                bootAfterInstall();
            });
            return;
        }
        bootAfterInstall();
    }

    private void bootAfterInstall() {
        final int port = prefs.getPort();
        if (RincyServer.isServing(port)) {
            loadedPort = port;
            loadChat(port);
            refreshStatus();
            return;
        }
        if (RincyServer.hasLiveProcess()) {
            startServer(true);
            return;
        }
        if (prefs.isAutostart()) startServer(false);
        else showChatStatus("Rincy 未启动", "点“启动”或打开自动启动", true);
    }

    private void startServer(boolean restart) {
        if (working) return;
        final int port = prefs.getPort();

        // 非重启请求时，服务已经在跑就直接打开页面，避免把自己刚起的服务杀掉
        if (!restart && RincyServer.isServing(port)) {
            loadedPort = port;
            loadChat(port);
            refreshStatus();
            return;
        }

        working = true;
        refreshStatus();
        showChatStatus(restart ? "正在重启…" : "正在启动…", "端口 " + port, false);

        new Thread(() -> {
            // 这里要么是用户要求重启，要么是检查时确实没在跑：
            // 先清掉可能残留的旧 node 进程，避免端口被占导致新进程起不来
            RincyServer.stop();
            String output = RincyServer.start(port);
            boolean ok = waitForPort(port, 40000);
            runOnUiThread(() -> {
                working = false;
                refreshStatus();
                if (ok) {
                    loadedPort = port;
                    loadChat(port);
                } else {
                    showChatStatus("启动失败", "请到设置 → 查看日志", true);
                    String tail = output == null ? "" : output.trim();
                    if (tail.length() > 400) tail = tail.substring(tail.length() - 400);
                    if (!tail.isEmpty()) toast(tail);
                }
            });
        }, "rincy-start").start();
    }

    private boolean waitForPort(int port, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (RincyServer.isServing(port)) return true;
            try {
                Thread.sleep(400);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    private void stopServer() {
        if (working) return;
        working = true;
        refreshStatus();
        new Thread(() -> {
            boolean killed = RincyServer.stop();
            runOnUiThread(() -> {
                working = false;
                loadedPort = -1;
                refreshStatus();
                showChatStatus("Rincy 已停止", "点“启动”可再次运行", true);
                toast(killed ? "已停止" : "服务未在运行");
            });
        }, "rincy-stop").start();
    }

    private void loadChat(int port) {
        if (webView == null) return;
        loadedPort = port;
        lastLoadAt = System.currentTimeMillis();
        hideChatStatus();
        webView.loadUrl("http://127.0.0.1:" + port + "/");
    }

    private void scheduleRetry() {
        handler.removeCallbacks(retryRunnable);
        handler.postDelayed(retryRunnable, RETRY_INTERVAL_MS);
    }

    private void refreshStatus() {
        int port = prefs.getPort();
        boolean serving = RincyServer.isServing(port);

        if (working) {
            statusTitle.setText("处理中…");
            startStopButton.setEnabled(false);
        } else {
            startStopButton.setEnabled(true);
            statusTitle.setText(serving ? "运行中" : "未运行");
        }
        startStopButton.setText(serving ? "停止" : "启动");

        String detail = "127.0.0.1:" + port
            + (RincyServer.isInstalled() ? " · 环境已部署" : " · 环境未部署");
        statusDetail.setText(detail);

        // 服务在跑但页面是空白时自动补一次（白屏自愈）
        if (serving && currentTab == TAB_CHAT && !working && webView != null
            && (loadedPort != port || webView.getUrl() == null)) {
            loadChat(port);
        }
    }

    private void showLog() {
        new Thread(() -> {
            String log = RincyServer.readLogTail(300);
            runOnUiThread(() -> {
                TextView view = new TextView(this);
                view.setText(log);
                view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
                view.setTypeface(Typeface.MONOSPACE);
                view.setTextColor(getResources().getColor(R.color.rincy_text));
                view.setTextIsSelectable(true);
                int pad = (int) (16 * getResources().getDisplayMetrics().density);
                view.setPadding(pad, pad, pad, pad);

                ScrollView scroll = new ScrollView(this);
                scroll.setBackgroundColor(getResources().getColor(R.color.rincy_bg));
                scroll.addView(view, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

                new AlertDialog.Builder(this)
                    .setTitle("启动日志")
                    .setView(scroll)
                    .setPositiveButton("关闭", null)
                    .show();
            });
        }, "rincy-log").start();
    }

    private void confirmReset() {
        new AlertDialog.Builder(this)
            .setTitle("重置运行环境")
            .setMessage("会删除解包出来的运行环境并重新从 APK 解包。\n\n"
                + "智能体与设置保存在 " + RincyServer.DATA_DIR + "，不会被删除。")
            .setNegativeButton("取消", null)
            .setPositiveButton("重置", (dialog, which) -> resetEnvironment())
            .show();
    }

    private void resetEnvironment() {
        if (working) return;
        working = true;
        refreshStatus();
        showChatStatus("正在重置运行环境…", null, false);
        new Thread(() -> {
            RincyServer.stop();
            RincyServer.resetEnvironment();
            runOnUiThread(() -> {
                working = false;
                loadedPort = -1;
                RincyServer.ensureBootstrap(this, () -> {
                    if (!RincyServer.hasPayload()) {
                        showChatStatus("重置失败", "缺少 " + RincyServer.BOOT_SCRIPT, false);
                        return;
                    }
                    toast("运行环境已重置");
                    startServer(false);
                });
            });
        }, "rincy-reset").start();
    }

    private void toast(String message) {
        if (message == null) return;
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }


    // 升级功能：直接在源目录执行 git pull
    private void runUpgrade() {
        if (working) return;
        working = true;
        refreshStatus();
        final String sourceUrl = getUpgradeUrl();
        new Thread(() -> {
            try {
                String cmd = sourceUrl.equals("default") ? "git pull" : "git pull " + sourceUrl + " main";
                java.lang.ProcessBuilder pb = new java.lang.ProcessBuilder(RincyServer.PREFIX + "/bin/sh", "-c",
                    "cd \"$HOME_DIR/rincy\" 2>/dev/null || cd \"$PAYLOAD/rincy\"; " + cmd);
                pb.redirectErrorStream(true);
                pb.environment().putAll(RincyServer.buildEnvironment(prefs.getPort()));
                java.lang.Process p = pb.start();
                try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream()))) {
                    String line; while ((line = r.readLine()) != null) System.out.println("[UPGRADE] " + line);
                }
                p.waitFor();
                runOnUiThread(() -> { working = false; refreshStatus(); toast("升级已尝试，结果见启动日志"); });
            } catch (Throwable t) {
                runOnUiThread(() -> { working = false; refreshStatus(); toast("升级异常: " + t.getMessage()); });
            }
        }, "rincy-upgrade").start();
    }

    private String getUpgradeUrl() {
        try {
            if (upgradeSourceGroup != null) {
                int id = upgradeSourceGroup.getCheckedRadioButtonId();
                if (id == R.id.upgradeGitee) return "https://gitee.com/mc2049/Rincy.git";
                if (id == R.id.upgradeCustom && upgradeUrlInput != null) {
                    String s = upgradeUrlInput.getText().toString().trim();
                    if (s.startsWith("https://") || s.startsWith("http://")) return s;
                }
            }
        } catch (Throwable ignored) {}
        return "https://github.com/mc2049/Rincy.git";
    }
}