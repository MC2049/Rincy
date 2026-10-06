package com.termux.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.preference.PreferenceManager;

/** 启动器的本地设置。 */
public final class RincyPrefs {

    public static final int DEFAULT_PORT = 4780;
    public static final String MODE_PLAYER = "player";
    public static final String MODE_DEV = "dev";

    private static final String KEY_PORT = "rincy.port";
    private static final String KEY_MODE = "rincy.mode";
    private static final String KEY_AUTOSTART = "rincy.autostart";

    private final SharedPreferences prefs;

    public RincyPrefs(Context context) {
        prefs = PreferenceManager.getDefaultSharedPreferences(context);
    }

    public int getPort() {
        return prefs.getInt(KEY_PORT, DEFAULT_PORT);
    }

    public void setPort(int port) {
        prefs.edit().putInt(KEY_PORT, port).apply();
    }

    public String getMode() {
        return prefs.getString(KEY_MODE, MODE_PLAYER);
    }

    public void setMode(String mode) {
        prefs.edit().putString(KEY_MODE, mode).apply();
    }

    public boolean isDevMode() {
        return MODE_DEV.equals(getMode());
    }

    public boolean isAutostart() {
        return prefs.getBoolean(KEY_AUTOSTART, true);
    }

    public void setAutostart(boolean enabled) {
        prefs.edit().putBoolean(KEY_AUTOSTART, enabled).apply();
    }
}
