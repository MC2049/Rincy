package com.termux.app;

import android.app.Activity;
import android.os.Process;
import android.system.Os;
import android.system.OsConstants;

import com.termux.shared.termux.TermuxConstants;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Rincy 运行环境与服务的控制。
 *
 * 目录约定 —— Termux 安装器把 bootstrap zip 的条目解到「前缀目录」下
 * （官方包顶层只有 bin/etc/lib/... 没有 home/），因此我们附加的 home/* 落在 $PREFIX/home：
 *
 *   $PREFIX/home/rincy-boot.sh        启动脚本
 *   $PREFIX/home/rincy/               Rincy 源码（含 node_modules）
 *   $PREFIX/home/node-runtime.tar.gz  Node 运行时
 *
 * 用户数据与日志放在真正的 $HOME（= files/home）下，这样「重置运行环境」不会丢数据：
 *
 *   $HOME/rincy-data/                 智能体与设置
 *   $HOME/rincy-boot.log              启动日志
 */
public final class RincyServer {

    public static final String PREFIX = TermuxConstants.TERMUX_PREFIX_DIR_PATH;
    public static final String HOME = TermuxConstants.TERMUX_HOME_DIR_PATH;
    public static final String PAYLOAD = PREFIX + "/home";
    public static final String BOOT_SCRIPT = PAYLOAD + "/rincy-boot.sh";
    public static final String SOURCE_DIR = PAYLOAD + "/rincy";
    public static final String NODE_RUNTIME = PAYLOAD + "/node-runtime.tar.gz";
    public static final String DATA_DIR = HOME + "/rincy-data";
    public static final String LOG_FILE = HOME + "/rincy-boot.log";
    public static final String PID_FILE = HOME + "/.rincy.pid";

    private RincyServer() {
    }

    /** bootstrap 是否已解包。 */
    public static boolean isInstalled() {
        return new File(PREFIX + "/bin/sh").exists();
    }

    /** APK 内置的启动载荷是否就位。 */
    public static boolean hasPayload() {
        return new File(BOOT_SCRIPT).exists();
    }

    /** 通过 TCP 连接判断服务是否在监听。 */
    public static boolean isServing(int port) {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 500);
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            try {
                socket.close();
            } catch (Throwable ignored) {
            }
        }
    }

    /** 触发 bootstrap 解包；已解包时 TermuxInstaller 会立即回调 whenDone。 */
    public static void ensureBootstrap(Activity activity, Runnable whenDone) {
        TermuxInstaller.setupBootstrapIfNeeded(activity, whenDone);
    }

    public static int readPid() {
        File file = new File(PID_FILE);
        if (!file.exists()) return -1;
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line = reader.readLine();
            return line == null ? -1 : Integer.parseInt(line.trim());
        } catch (Throwable t) {
            return -1;
        }
    }

    /** 停止服务；返回是否确实结束了进程。 */
    public static boolean stop() {
        boolean killed = false;
        int pid = readPid();
        if (pid > 0 && isAlive(pid)) {
            signal(pid);
            killed = true;
        }
        // PID 文件可能丢失或过期：扫描同 UID 下运行 src/server.js 的进程兜底
        File proc = new File("/proc");
        File[] entries = proc.listFiles();
        if (entries != null) {
            for (File entry : entries) {
                if (!entry.isDirectory()) continue;
                int candidate;
                try {
                    candidate = Integer.parseInt(entry.getName());
                } catch (Throwable t) {
                    continue;
                }
                if (candidate == pid || candidate == Process.myPid()) continue;
                if (isRincyServerProcess(candidate)) {
                    signal(candidate);
                    killed = true;
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        new File(PID_FILE).delete();
        return killed;
    }

    private static void signal(int pid) {
        try {
            Os.kill(pid, OsConstants.SIGTERM);
        } catch (Throwable ignored) {
        }
        try {
            Thread.sleep(400);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        if (isAlive(pid)) {
            try {
                Os.kill(pid, OsConstants.SIGKILL);
            } catch (Throwable ignored) {
            }
        }
    }

    private static boolean isAlive(int pid) {
        return new File("/proc/" + pid).exists();
    }

    /** 只认「本应用 UID 且在跑 Rincy 服务」的进程，避免误杀。 */
    private static boolean isRincyServerProcess(int pid) {
        String cmdline = readProcFile(pid, "cmdline");
        if (cmdline == null || !cmdline.contains("src/server.js")) return false;
        String status = readProcFile(pid, "status");
        if (status == null) return false;
        return status.contains("Uid:\t" + Process.myUid());
    }

    private static String readProcFile(int pid, String name) {
        try (InputStream in = new FileInputStream("/proc/" + pid + "/" + name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8).replace('\0', ' ');
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 阻塞执行启动脚本，返回脚本输出。
     * 脚本内部会解包 Node 运行时并用 setsid 把 node 挂到独立会话，因此脚本退出后服务仍在。
     */
    public static String start(int port) {
        StringBuilder output = new StringBuilder();
        try {
            ProcessBuilder builder = new ProcessBuilder(PREFIX + "/bin/sh", BOOT_SCRIPT);
            builder.redirectErrorStream(true);
            builder.environment().put("RINCY_PORT", String.valueOf(port));
            builder.environment().put("RINCY_DATA_DIR", DATA_DIR);
            java.lang.Process process = builder.start();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) output.append(line).append('\n');
            }
            process.waitFor();
        } catch (Throwable t) {
            output.append("启动异常: ").append(t);
        }
        return output.toString();
    }

    /** 读取启动日志末尾若干行。 */
    public static String readLogTail(int maxLines) {
        File file = new File(LOG_FILE);
        if (!file.exists()) return "(暂无日志：" + LOG_FILE + ")";
        Deque<String> tail = new ArrayDeque<>();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                tail.addLast(line);
                if (tail.size() > maxLines) tail.removeFirst();
            }
        } catch (Throwable t) {
            return "读取日志失败: " + t;
        }
        StringBuilder builder = new StringBuilder();
        for (String line : tail) builder.append(line).append('\n');
        return builder.toString();
    }

    /** 删除前缀目录以便重新解包；$HOME 下的用户数据不受影响。 */
    public static void resetEnvironment() {
        deleteRecursively(new File(PREFIX));
        //noinspection ResultOfMethodCallIgnored
        new File(PID_FILE).delete();
    }

    private static void deleteRecursively(File file) {
        String path = file.getAbsolutePath();
        if (isSymlink(path)) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static boolean isSymlink(String path) {
        try {
            return (Os.lstat(path).st_mode & OsConstants.S_IFMT) == OsConstants.S_IFLNK;
        } catch (Throwable t) {
            return false;
        }
    }
}
