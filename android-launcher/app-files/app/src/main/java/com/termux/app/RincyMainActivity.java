package com.termux.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
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
    private View devGroup;
    private TextView devPaths;

    private int currentTab = TAB_CHAT;
    private boolean working = false;
    private int loadedPort = -1;

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
        refreshStatus();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
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

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        webView.setBackgroundColor(getResources().getColor(R.color.rincy_bg));
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (loadedPort > 0) hideChatStatus();
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showChatStatus("无法连接 Rincy", "服务可能还没起来，稍等或点“重试”", true);
            }
        });

        findViewById(R.id.chatRetryButton).setOnClickListener(v -> {
            hideChatStatus();
            startServer(true);
        });
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
        findViewById(R.id.btnUpgrade).setOnClickListener(v -> runUpgrade());
n        findViewById(R.id.btnUpgrade).setOnClickListener(v -> runUpgrade());
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
                if (prefs.isAutostart()) startServer(false);
                else showChatStatus("Rincy 未启动", "点“启动”或打开自动启动", true);
            });
            return;
        }
        if (prefs.isAutostart()) startServer(false);
        else showChatStatus("Rincy 未启动", "点“启动”或打开自动启动", true);
    }

    private void startServer(boolean restart) {
        if (working) return;
        final int port = prefs.getPort();
        working = true;
        refreshStatus();
        showChatStatus(restart ? "正在重启…" : "正在启动…", "端口 " + port, false);

        new Thread(() -> {
            if (restart || RincyServer.isServing(port)) RincyServer.stop();
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
        hideChatStatus();
        webView.loadUrl("http://127.0.0.1:" + port + "/");
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

        // 服务已起来但 WebView 之前加载失败时自动补一次
        if (serving && currentTab == TAB_CHAT && chatStatusBox.getVisibility() == View.VISIBLE
            && loadedPort != port && !working) {
            loadedPort = port;
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
}

    // 升级功能：直接在源目录执行 git pull（需要设备已安装 git，且源自解包自带源码）
    private void runUpgrade() {
        if (working) return;
        working = true;
        refreshStatus();
        final String sourceUrl = getUpgradeUrl();
        new Thread(() -> {
            try {
                String cmd = sourceUrl.equals("default") ? "git pull" : "git pull " + sourceUrl + " main";
                java.lang.ProcessBuilder pb = new java.lang.ProcessBuilder(PREFIX + "/bin/sh", "-c",
                    "cd \"$HOME_DIR/rincy\" 2>/dev/null || cd \"$PAYLOAD/rincy\"; " + cmd);
                pb.redirectErrorStream(true);
                pb.environment().putAll(RincyServer.buildEnvironment(prefs.getPort()));
                pb.environment().put("TERM", "xterm-256color");
                java.lang.Process p = pb.start();
                try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream()))) {
                    String line; while ((line = r.readLine()) != null) {
                        System.out.println("[RINY-UPGRADE] " + line);
                    }
                }
                p.waitFor();
                runOnUiThread(() -> {
                    working = false;
                    refreshStatus();
                    toast("升级已尝试，结果见启动日志");
                });
            } catch (Throwable t) {
                runOnUiThread(() -> { working = false; refreshStatus(); toast("升级异常: " + t.getMessage()); });
            }
        }, "rincy-upgrade").start();
    }

    private String getUpgradeUrl() {
        try {
            RadioGroup group = findViewById(R.id.upgradeSourceGroup);
            if (group != null) {
                int id = group.getCheckedRadioButtonId();
                if (id == R.id.upgradeGitee) return "https://gitee.com/mc2049/Rincy.git";
                if (id == R.id.upgradeCustom) {
                    EditText urlInput = findViewById(R.id.upgradeUrlInput);
                    if (urlInput != null) {
                        String s = urlInput.getText().toString().trim();
                        if (s.startsWith("https://") || s.startsWith("http://")) return s;
                    }
                }
            }
        } catch (Throwable ignored) {}
        return "https://github.com/mc2049/Rincy.git";

    // 升级功能：直接在源目录执行 git pull（需要设备已安装 git，且源自解包自带源码）
    private void runUpgrade() {
        if (working) return;
        working = true;
        refreshStatus();
        final String sourceUrl = getUpgradeUrl();
        new Thread(() -> {
            try {
                // 优先使用设备已安装的 git
                String cmd = sourceUrl.equals("default") ? "git pull" : "git pull " + sourceUrl + " main";
                java.lang.ProcessBuilder pb = new java.lang.ProcessBuilder(PREFIX + "/bin/sh", "-c", 
                    "cd "$HOME_DIR/rincy" 2>/dev/null || cd "$PAYLOAD/rincy"; " + cmd);
                pb.redirectErrorStream(true);
                pb.environment().putAll(RincyServer.buildEnvironment(prefs.getPort()));
                java.lang.Process p = pb.start();
                try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream()))) {
                    String line; while ((line = r.readLine()) != null) {
                        System.out.println("[RINY-UPGRADE] " + line);
                    }
                }
                p.waitFor();
                runOnUiThread(() -> {
                    working = false;
                    refreshStatus();
                    toast("升级已尝试，结果见启动日志");
                });
            } catch (Throwable t) {
                runOnUiThread(() -> { working = false; refreshStatus(); toast("升级异常: " + t.getMessage()); });
            }
        }, "rincy-upgrade").start();
    }

    private String getUpgradeUrl() {
        try {
            RadioGroup group = findViewById(R.id.upgradeSourceGroup);
            if (group != null) {
                int id = group.getCheckedRadioButtonId();
                if (id == R.id.upgradeGitee) return "https://gitee.com/mc2049/Rincy.git";
                if (id == R.id.upgradeCustom) {
                    EditText urlInput = findViewById(R.id.upgradeUrlInput);
                    if (urlInput != null) {
                        String s = urlInput.getText().toString().trim();
                        if (s.startsWith("https://") || s.startsWith("http://")) return s;
                    }
                }
            }
        } catch (Throwable ignored) {}
        return "https://github.com/mc2049/Rincy.git";
    }
    }
