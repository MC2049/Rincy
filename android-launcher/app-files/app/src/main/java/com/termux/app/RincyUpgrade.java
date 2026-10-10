package com.termux.app;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;

/**
 * Rincy 升级：从 GitHub / Gitee / 自定义源拉取源码归档，覆盖到设备上的运行目录。
 *
 * 为什么不用 git pull：
 *   随包的 Termux 载荷里既没有 git 可执行文件，home/rincy 也不是 git 仓库
 *   （它是 bootstrap zip 直接解出来的），所以 git pull 必然失败。
 * 这里改用 HTTP 下载 archive 归档 + 自己解 tar.gz，只依赖 JDK 自带的类，
 * 不依赖 git / curl / tar / openssl，也不受旧包名前缀问题影响。
 *
 * 运行时目录里 node_modules 会被保留（上游仓库本来也不跟踪它），
 * 其它运行文件（src/、web/、start.sh、package.json …）按归档内容刷新。
 */
public final class RincyUpgrade {

    /** 升级过程中的界面回调，全部在工作线程上触发。 */
    public interface Progress {
        /**
         * @param text   给用户看的一句话
         * @param percent 0-100，-1 表示进度不确定
         */
        void onProgress(String text, int percent);
    }

    private static final String BRANCH = "main";
    private static final int TAR_BLOCK = 512;
    private static final int MAX_REDIRECT = 5;
    /** 运行目录里必须保留、绝不能被归档覆盖的目录名。 */
    private static final String KEEP_DIR = "node_modules";

    /**
     * Android 端专用改动的保护名单：{文件, 标记}。
     *
     * 这些改动如果还没推到远端，直接覆盖会把设备上的版本改回旧实现：
     * 例如 src/config.js 里的 RINCY_DATA_DIR —— 被改回去后数据会落到载荷目录，
     * 「重置运行环境」会把用户数据一并清掉。
     * 规则：本地版本含标记、而下载到的版本不含时，跳过该文件；
     * 等改动推上远端后两边都含标记，就会正常参与升级。
     */
    private static final String[][] GUARDS = {
        {"src/config.js", "RINCY_DATA_DIR"},
    };

    private RincyUpgrade() {
    }

    /** 升级结果。 */
    public static final class Result {
        public String archiveUrl = "";
        public int updated = 0;      // 内容有变化的文件
        public int unchanged = 0;    // 内容一致
        public int added = 0;        // 新增文件
        public int guarded = 0;      // 因含 Android 专用改动而被跳过的文件
        public boolean packageChanged = false;
        public String backupPath = "";

        public String summary() {
            StringBuilder sb = new StringBuilder();
            sb.append("已更新 ").append(updated).append(" 个文件");
            if (added > 0) sb.append("，新增 ").append(added).append(" 个");
            if (unchanged > 0) sb.append("，").append(unchanged).append(" 个无变化");
            if (updated == 0 && added == 0) sb.append("（已是最新版）");
            if (guarded > 0) {
                sb.append("；有 ").append(guarded)
                  .append(" 个文件含 Android 专用改动被跳过（远端还没这些改动，建议先推送）");
            }
            if (packageChanged) sb.append("；依赖有变化，建议重装环境");
            return sb.toString();
        }
    }

    // ------------------------------------------------------------------
    // 源地址解析
    // ------------------------------------------------------------------

    /**
     * 把「升级源」规范成可以直接下载的归档地址。
     * 支持：github/gitee 的仓库地址、已经写好的归档地址、空值（默认 GitHub）。
     */
    public static String archiveUrlFor(String source) {
        String s = source == null ? "" : source.trim();
        if (s.isEmpty()) s = "https://github.com/MC2049/Rincy.git";
        // 已经是归档地址就直接用
        if (s.contains("/archive/") || s.contains("/repository/archive/")
            || s.endsWith(".tar.gz") || s.endsWith(".tgz")) {
            return s;
        }
        // 允许用户填 owner/repo 这种简写
        if (!s.contains("://") && s.indexOf('/') > 0) {
            s = "https://github.com/" + s;
        }
        String base = s;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (base.endsWith(".git")) base = base.substring(0, base.length() - 4);
        if (base.contains("gitee.com")) {
            // gitee: https://gitee.com/owner/repo/repository/archive/main.tar.gz
            return base + "/repository/archive/" + BRANCH + ".tar.gz";
        }
        // github: https://github.com/owner/repo/archive/refs/heads/main.tar.gz
        return base + "/archive/refs/heads/" + BRANCH + ".tar.gz";
    }

    // ------------------------------------------------------------------
    // 全流程
    // ------------------------------------------------------------------

    /**
     * @param workDir   临时/备份目录，例如 $HOME/rincy-upgrade
     * @param targetDir 运行目录，例如 $PREFIX/home/rincy
     */
    public static Result run(File workDir, File targetDir, String sourceUrl, Progress p)
        throws IOException {
        Result result = new Result();
        result.archiveUrl = archiveUrlFor(sourceUrl);

        if (!workDir.exists() && !workDir.mkdirs()) {
            throw new IOException("无法创建目录 " + workDir);
        }
        File extractDir = new File(workDir, "extract");

        report(p, "正在连接 " + hostOf(result.archiveUrl) + " …", 0);

        // 依次换 User-Agent 试：Gitee 的 WAF 只放行 curl/wget 这类 UA，
        // 用浏览器或 Java 默认 UA 会拿到一个 HTML 拦截页（曾导致「不是 gzip 格式」）。
        String problem = null;
        int files = 0;
        for (int i = 0; i < USER_AGENTS.length; i++) {
            File archive = new File(workDir, "rincy-src." + i + ".bin");
            long bytes;
            String kind;
            try {
                bytes = download(result.archiveUrl, archive, USER_AGENTS[i], p);
                kind = sniff(archive);
            } catch (IOException e) {
                problem = e.getMessage();
                deleteRecursively(archive);
                continue;
            }
            if (kind == null || "html".equals(kind)) {
                problem = "源返回的是网页而不是压缩包（" + describe(archive)
                    + "），可能是下载站点的拦截页";
                deleteRecursively(archive);
                report(p, "换一个请求方式重试…", -1);
                continue;
            }
            report(p, "下载完成（" + (bytes / 1024) + " KB，" + kind + "），正在解压…", 40);
            deleteRecursively(extractDir);
            if (!extractDir.mkdirs()) throw new IOException("无法创建目录 " + extractDir);
            int extracted = 0;
            try {
                extracted = extract(archive, extractDir, kind, p);
            } catch (IOException extractErr) {
                problem = "解压失败（" + extractErr.getMessage()
                    + "）；文件头部可能已被下载站点截断或格式异常，尝试重试";
                deleteRecursively(archive);
                continue; // 换 UA 重试
            }
            deleteRecursively(archive);
            if (extracted > 0) {
                files = extracted;
                problem = null;
                break;
            }
            problem = "归档里没有解出任何文件，可能源地址不对或仓库为空";
        }
        if (problem != null || files == 0) {
            throw new IOException(problem == null ? "升级失败：没有取到可用文件" : problem);
        }

        // 归档解出来通常是一层 Rincy-main/，保险起见再探测一次真正的根
        File srcRoot = findSourceRoot(extractDir);
        report(p, "解压出 " + files + " 个文件，正在覆盖运行目录…", 70);

        File backup = new File(workDir, "backup-" + System.currentTimeMillis());
        overlay(srcRoot, targetDir, backup, result, p);

        if (backup.exists()) {
            result.backupPath = backup.getAbsolutePath();
        } else {
            // 没有任何文件被改写，不用留空备份目录
            deleteRecursively(backup);
        }
        
        // 升级后自动清理旧备份，保留最近 5 个
        cleanupBackups(workDir, 5);
        
        report(p, result.summary(), 100);
        return result;
    }
    
    /**
     * 删除旧版本的备份，保留最近 N 个备份。
     * @param workDir 当前工作目录
     * @param keepCount 保留最近多少个备份
     * @return 保留下来的备份数量
     */
    public static int cleanupBackups(File workDir, int keepCount) {
        // 直接在 workDir 下查找 backup-{timestamp} 目录
        File[] backups = workDir.listFiles((dir, name) -> name.matches("backup-\\d+"));
        if (backups == null || backups.length == 0) return 0;
        
        // 按时间戳排序（新到旧）
        java.util.Arrays.sort(backups, (a, b) -> Long.compare(
            Long.parseLong(a.getName().replace("backup-", "")),
            Long.parseLong(b.getName().replace("backup-", ""))));
        
        // 保留最新的 keepCount 个，删除其余
        int total = backups.length;
        int toDelete = Math.max(0, total - keepCount);
        for (int i = 0; i < toDelete; i++) {
            File file = backups[i];
            try {
                if (!file.delete()) {
                    // 如果删除失败，尝试删除其子文件
                    deleteRecursively(file);
                }
            } catch (Throwable ignored) {
            }
        }
        return total - toDelete;
    }

    /** 读取文件头判断真实格式——不能信 Content-Type，Gitee 会返回 HTML 拦截页。 */
    static String sniff(File f) {
        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
            byte[] head = new byte[512];
            int n = readAtMost(in, head, head.length);
            if (n < 2) return null;
            int b0 = head[0] & 0xFF, b1 = head[1] & 0xFF;
            if (b0 == 0x1F && b1 == 0x8B) return "gzip";
            if (b0 == 0x50 && b1 == 0x4B) return "zip";
            if (b0 == 0x3C) return "html";                    // '<' —— HTML/XML
            if (n >= 265 && head[257] == 'u' && head[258] == 's' && head[259] == 't'
                && head[260] == 'a' && head[261] == 'r') return "tar";
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 出错时给用户看的前几个字节，便于判断究竟拿到了什么。 */
    static String describe(File f) {
        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
            byte[] head = new byte[24];
            int n = readAtMost(in, head, head.length);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < n && i < 12; i++) {
                int c = head[i] & 0xFF;
                sb.append(c >= 32 && c < 127 ? (char) c : '.');
            }
            return "开头是 \"" + sb + "\"";
        } catch (Throwable t) {
            return "格式未知";
        }
    }

    static int extract(File archive, File destRoot, String kind, Progress p) throws IOException {
        if ("zip".equals(kind)) return extractZip(archive, destRoot, 1, p);
        if ("tar".equals(kind)) return extractTar(archive, destRoot, 1, p);
        return extractTarGz(archive, destRoot, 1, p);
    }

    static int readAtMost(InputStream in, byte[] buf, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) break;
            off += n;
        }
        return off;
    }

    // ------------------------------------------------------------------
    // 下载
    // ------------------------------------------------------------------

    /**
     * Gitee 的 WAF 只放行 curl / wget 这类 UA；用 Java 默认 UA 会拿到 HTML 拦截页。
     * 所以按顺序轮换，配合格式嗅探找到真正能用的那个。
     */
    private static final String[] USER_AGENTS = {
        "curl/8.5.0",
        "Wget/1.21",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };

    private static long download(String url, File dest, String userAgent, Progress p)
        throws IOException {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECT; hop++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(current).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("User-Agent", userAgent);
            conn.setRequestProperty("Accept", "*/*");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null || loc.isEmpty()) throw new IOException("重定向缺少 Location");
                if (loc.startsWith("/")) {
                    URL base = new URL(current);
                    // 注意带上端口：getHost() 不含端口，拼出来的地址会掉到 80/443
                    loc = base.getProtocol() + "://" + base.getAuthority() + loc;
                }
                current = loc;
                continue;
            }
            if (code != 200) {
                conn.disconnect();
                String msg = conn.getResponseMessage();
                if (code == 404) {
                    throw new IOException("HTTP 404：源上没有这个仓库/分支（" + current + "）");
                }
                throw new IOException("HTTP " + code + (msg == null ? "" : " " + msg));
            }

            long total = conn.getContentLengthLong();
            long done = 0;
            byte[] buf = new byte[1 << 16];
            try (InputStream in = new BufferedInputStream(conn.getInputStream(), 1 << 16);
                 OutputStream out = new BufferedOutputStream(new FileOutputStream(dest), 1 << 16)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        report(p, "正在下载 " + (done / 1024) + " / " + (total / 1024) + " KB",
                            (int) (done * 40 / total));
                    } else {
                        report(p, "正在下载 " + (done / 1024) + " KB", -1);
                    }
                }
            } finally {
                conn.disconnect();
            }
            if (done == 0) throw new IOException("下载到 0 字节，源可能不可用");
            return done;
        }
        throw new IOException("重定向次数过多（超过 " + MAX_REDIRECT + " 次）");
    }

    // ------------------------------------------------------------------
    // tar.gz 解包
    // ------------------------------------------------------------------

    /**
     * 解 GNU/PAX/ustar 格式的 tar.gz。
     *
     * @param strip 去掉路径最前面的层数（GitHub/Gitee 归档都多一层仓库名目录）
     * @return 实际写出的文件数
     */
    static int extractTarGz(File archive, File destRoot, int strip, Progress p) throws IOException {
        try (GZIPInputStream gz = new GZIPInputStream(
            new BufferedInputStream(new FileInputStream(archive), 1 << 16), 1 << 16)) {
            return extractTarStream(gz, destRoot, strip, p);
        }
    }

    static int extractTar(File archive, File destRoot, int strip, Progress p) throws IOException {
        try (InputStream in = new BufferedInputStream(new FileInputStream(archive), 1 << 16)) {
            return extractTarStream(in, destRoot, strip, p);
        }
    }

    /** 解 zip 归档（有些源会直接给 zip）。 */
    static int extractZip(File archive, File destRoot, int strip, Progress p) throws IOException {
        int written = 0;
        try (java.util.zip.ZipInputStream zin = new java.util.zip.ZipInputStream(
            new BufferedInputStream(new FileInputStream(archive), 1 << 16))) {
            java.util.zip.ZipEntry entry;
            byte[] buf = new byte[1 << 16];
            while ((entry = zin.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String rel = stripComponents(entry.getName(), strip);
                if (rel == null || rel.length() == 0 || rel.startsWith("..")) continue;
                File out = new File(destRoot, rel);
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out), 1 << 16)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
                written++;
                if (written % 25 == 0) report(p, "正在解压（已 " + written + " 个文件）…", -1);
            }
        }
        return written;
    }

    static int extractTarStream(InputStream gz, File destRoot, int strip, Progress p)
        throws IOException {
        int written = 0;
        String paxPath = null;
        {
            byte[] hdr = new byte[TAR_BLOCK];
            while (true) {
                if (!readFully(gz, hdr, TAR_BLOCK)) break;
                if (isZeroBlock(hdr)) break;

                String name = readString(hdr, 0, 100);
                String prefix = readString(hdr, 345, 155);
                if (prefix.length() > 0) name = prefix + "/" + name;
                long size = readOctal(hdr, 124, 12);
                int type = hdr[156] & 0xFF;
                long padded = (size + TAR_BLOCK - 1) / TAR_BLOCK * TAR_BLOCK;

                // PAX 扩展头：真正的路径写在数据区里
                if (type == 'x' || type == 'g') {
                    byte[] data = readN(gz, size);
                    skipFully(gz, padded - size);
                    if (type == 'x') {
                        String realPath = paxValue(data, "path");
                        if (realPath != null && realPath.length() > 0) paxPath = realPath;
                    }
                    continue;
                }

                if (paxPath != null) {
                    name = paxPath;
                    paxPath = null;
                }

                boolean regular = (type == '0' || type == 0 || type == ' ');
                String rel = regular ? stripComponents(name, strip) : null;
                if (regular && rel != null && rel.length() > 0 && !rel.startsWith("..")) {
                    File out = new File(destRoot, rel);
                    File parent = out.getParentFile();
                    if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
                        throw new IOException("无法创建目录 " + parent);
                    }
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out), 1 << 16)) {
                        copyN(gz, os, size);
                    }
                    written++;
                    skipFully(gz, padded - size);
                    if (written % 25 == 0) {
                        report(p, "正在解压（已 " + written + " 个文件）…", -1);
                    }
                } else {
                    // 目录 / 符号链接 / 不安全的路径：整块跳过
                    skipFully(gz, padded);
                }
            }
        }
        return written;
    }

    static String stripComponents(String path, int strip) {
        String p = path;
        while (p.startsWith("./")) p = p.substring(2);
        if (p.startsWith("/")) p = p.substring(1);
        for (int i = 0; i < strip; i++) {
            int slash = p.indexOf('/');
            if (slash < 0) return null;      // 层级不够，说明是顶层目录自身
            p = p.substring(slash + 1);
        }
        return p;
    }

    /** PAX 记录格式： "<长度> <key>=<value>\n" */
    static String paxValue(byte[] data, String key) {
        String text = new String(data, java.nio.charset.Charset.forName("UTF-8"));
        String needle = " " + key + "=";
        int from = 0;
        while (true) {
            int space = text.indexOf(' ', from);
            if (space < 0) return null;
            if (text.startsWith(needle, space)) {
                int start = space + needle.length();
                int nl = text.indexOf('\n', start);
                return nl < 0 ? text.substring(start) : text.substring(start, nl);
            }
            int nl = text.indexOf('\n', space);
            if (nl < 0) return null;
            from = nl + 1;
        }
    }

    // ------------------------------------------------------------------
    // 覆盖到运行目录
    // ------------------------------------------------------------------

    /** 归档里如果有嵌套的一层目录，找到真正的仓库根。 */
    static File findSourceRoot(File extractDir) {
        File[] kids = extractDir.listFiles();
        if (kids == null || kids.length == 0) return extractDir;
        if (kids.length == 1 && kids[0].isDirectory()) return kids[0];
        return extractDir;
    }

    private static void overlay(File srcRoot, File target, File backup,
                                Result result, Progress p) throws IOException {
        List<File> all = new ArrayList<File>();
        collect(srcRoot, all);
        int handled = 0;
        for (File src : all) {
            String rel = relativize(srcRoot, src);
            if (rel == null) continue;
            if (isInsideKeepDir(rel)) continue;
            // 只刷新运行需要的文件：src/ 与 web/ 全量，其它只覆盖运行目录里已有的
            File dst = new File(target, rel);
            boolean runtime = rel.startsWith("src/") || rel.startsWith("web/");
            if (!runtime && !dst.exists() && !isTopLevelRuntimeFile(rel)) continue;

            byte[] incoming = readFile(src);
            boolean existed = dst.exists();
            byte[] old = existed ? readFile(dst) : null;

            // 保护 Android 专用改动：本地有标记、远端没有 → 跳过，别把设备改回旧实现
            String marker = guardMarkerFor(rel);
            if (marker != null && existed && contains(old, marker) && !contains(incoming, marker)) {
                result.guarded++;
                continue;
            }

            if (existed && same(old, incoming)) {
                result.unchanged++;
            } else {
                if (existed) {
                    // 改动前留一份备份，升级出问题能手工还原
                    File bak = new File(backup, rel);
                    File bakParent = bak.getParentFile();
                    if (bakParent != null) bakParent.mkdirs();
                    writeFile(bak, old);
                    result.updated++;
                } else {
                    result.added++;
                }
                if ("package.json".equals(rel) || "package-lock.json".equals(rel)) {
                    result.packageChanged = true;
                }
                File parent = dst.getParentFile();
                if (parent != null) parent.mkdirs();
                writeFile(dst, incoming);
            }
            handled++;
            if (handled % 20 == 0) {
                report(p, "正在覆盖（已处理 " + handled + " 个文件）…", -1);
            }
        }
    }

    private static boolean isInsideKeepDir(String rel) {
        return rel.equals(KEEP_DIR) || rel.startsWith(KEEP_DIR + "/");
    }

    /** 返回该文件对应的保护标记；不受保护则返回 null。 */
    private static String guardMarkerFor(String rel) {
        for (String[] guard : GUARDS) {
            if (guard[0].equals(rel)) return guard[1];
        }
        return null;
    }

    /** 字节内容里是否包含某个 ASCII 标记。 */
    static boolean contains(byte[] data, String marker) {
        if (data == null || marker == null || marker.isEmpty()) return false;
        byte[] m = marker.getBytes(java.nio.charset.Charset.forName("UTF-8"));
        outer:
        for (int i = 0; i + m.length <= data.length; i++) {
            for (int j = 0; j < m.length; j++) {
                if (data[i + j] != m[j]) continue outer;
            }
            return true;
        }
        return false;
    }

    private static boolean isTopLevelRuntimeFile(String rel) {
        return rel.equals("start.sh") || rel.equals("package.json")
            || rel.equals("package-lock.json") || rel.equals("README.md");
    }

    private static void collect(File dir, List<File> out) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory()) collect(k, out);
            else out.add(k);
        }
    }

    private static String relativize(File root, File f) {
        String r = root.getAbsolutePath();
        String a = f.getAbsolutePath();
        if (!a.startsWith(r)) return null;
        String rel = a.substring(r.length());
        while (rel.startsWith("/")) rel = rel.substring(1);
        return rel;
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    private static void report(Progress p, String text, int percent) {
        if (p != null) p.onProgress(text, percent);
    }

    private static String hostOf(String url) {
        try {
            return new URL(url).getHost();
        } catch (Throwable t) {
            return url;
        }
    }

    static boolean readFully(InputStream in, byte[] buf, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) return false;
            off += n;
        }
        return true;
    }

    static byte[] readN(InputStream in, long len) throws IOException {
        if (len <= 0) return new byte[0];
        if (len > 4L * 1024 * 1024) throw new IOException("tar 头过大: " + len);
        ByteArrayOutputStream bos = new ByteArrayOutputStream((int) len);
        byte[] buf = new byte[8192];
        long left = len;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new IOException("tar 数据意外结束");
            bos.write(buf, 0, n);
            left -= n;
        }
        return bos.toByteArray();
    }

    static void copyN(InputStream in, OutputStream out, long len) throws IOException {
        byte[] buf = new byte[1 << 16];
        long left = len;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new IOException("tar 数据意外结束");
            out.write(buf, 0, n);
            left -= n;
        }
    }

    static void skipFully(InputStream in, long len) throws IOException {
        long left = len;
        byte[] buf = new byte[8192];
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) return;
            left -= n;
        }
    }

    static boolean isZeroBlock(byte[] block) {
        for (byte b : block) {
            if (b != 0) return false;
        }
        return true;
    }

    static String readString(byte[] block, int off, int len) {
        int end = off;
        int limit = Math.min(off + len, block.length);
        while (end < limit && block[end] != 0) end++;
        return new String(block, off, end - off, java.nio.charset.Charset.forName("UTF-8")).trim();
    }

    static long readOctal(byte[] block, int off, int len) {
        long v = 0;
        int limit = Math.min(off + len, block.length);
        for (int i = off; i < limit; i++) {
            int c = block[i] & 0xFF;
            if (c == 0 || c == ' ') {
                if (v > 0) break;
                continue;
            }
            if (c < '0' || c > '7') break;
            v = (v << 3) + (c - '0');
        }
        return v;
    }

    static byte[] readFile(File f) throws IOException {
        long len = f.length();
        if (len > 32L * 1024 * 1024) throw new IOException("文件过大: " + f);
        ByteArrayOutputStream bos = new ByteArrayOutputStream((int) len);
        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    static void writeFile(File f, byte[] data) throws IOException {
        File parent = f.getParentFile();
        if (parent != null) parent.mkdirs();
        try (OutputStream out = new BufferedOutputStream(new FileOutputStream(f))) {
            out.write(data);
        }
    }

    static boolean same(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) return false;
        for (int i = 0; i < a.length; i++) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursively(k);
        }
        f.delete();
    }
}
