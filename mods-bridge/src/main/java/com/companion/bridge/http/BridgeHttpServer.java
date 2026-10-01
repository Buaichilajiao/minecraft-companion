package com.companion.bridge.http;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.companion.bridge.ModBridge;
import net.minecraft.client.Minecraft;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.function.Supplier;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * 客户端桥 HTTP 通道（HTTP 长轮询，零依赖，JDK 内置 com.sun.net.httpserver）。
 *
 * mods-bridge = 客户端模组，此服务监听本机端口，供 TS 侧 (ClientExecutionShell) 查询/下发指令。
 *
 * 路由：
 *   GET  /bridge_probe          -> 读当前已打开的 containerMenu(窗口协议) -> 返回 JSON
 *   GET  /health                -> 存活探测
 *   POST /cmd                   -> 指令通道（第二步再加，预留）
 *
 * 鉴权：默认仅绑定 127.0.0.1(本机回环)，不接受外网请求——TS 客户端与 mod 同机。
 * 线程模型：每个 handler 用 CompletableFuture + Minecraft.execute() 切回客户端主线程读容器，
 *          避免跨线程访问 Minecraft 状态。
 */
public final class BridgeHttpServer {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static volatile HttpServer SERVER;
    private static volatile String TOKEN; // 启动时随机生成，见 initToken()
    private static final int DEFAULT_PORT = 8756; // companion-bridge 默认端口

    private BridgeHttpServer() {}

    /** 在 ModBridge 构造时调用：启动本机 HTTP 服务。 */
    public static void start() {
        if (SERVER != null) return;
        initToken();
        int port = Integer.getInteger("companion.bridge.port", DEFAULT_PORT);
        String host = System.getProperty("companion.bridge.host", "127.0.0.1");
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
            server.createContext("/health", BridgeHttpServer::handleHealth);
            server.createContext("/bridge_probe", BridgeHttpServer::handleProbe);
            server.createContext("/cmd", BridgeHttpServer::handleCmd);
            server.setExecutor(Executors.newFixedThreadPool(4));
            server.start();
            SERVER = server;
            ModBridge.LOGGER.info("[companion-bridge] HTTP 通道已启动: http://{}:{} (token 见 {}", host, port, TOKEN_SOURCE_FILE);
        } catch (IOException e) {
            ModBridge.LOGGER.error("[companion-bridge] HTTP 通道启动失败", e);
        }
    }

    /**
     * token：优先取系统属性 companion.bridge.token(固定值, 便于联调)；
     * 否则随机生成 16 字节 hex 并写到本地文件，供同机 TS 侧读取。
     */
    private static volatile String TOKEN_SOURCE_FILE = null;
    private static void initToken() {
        String fixed = System.getProperty("companion.bridge.token");
        if (fixed != null && !fixed.isBlank()) {
            TOKEN = fixed.trim();
            return;
        }
        byte[] bytes = new byte[16];
        new java.security.SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        TOKEN = sb.toString();
        try {
            java.nio.file.Path p = java.nio.file.Path.of("companion-bridge.token").toAbsolutePath();
            java.nio.file.Files.writeString(p, TOKEN, StandardCharsets.UTF_8);
            TOKEN_SOURCE_FILE = p.toString();
        } catch (IOException e) {
            TOKEN_SOURCE_FILE = "<内存态，未能写文件>";
            ModBridge.LOGGER.warn("[companion-bridge] token 文件写入失败(仅内存可用): {}", e.getMessage());
        }
    }

    /** HTTP 鉴权：从 Authorization: Bearer <token> 或 ?token=<token> 读取并比对。 */
    private static boolean checkToken(HttpExchange ex) {
        if (TOKEN == null) return false;
        String auth = ex.getRequestHeaders().getFirst("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            return TOKEN.equals(auth.substring(7).trim());
        }
        String query = ex.getRequestURI().getRawQuery();
        if (query != null) {
            String[] parts = query.split("&");
            for (String p : parts) {
                if (p.startsWith("token=") && p.length() > 6) {
                    return TOKEN.equals(p.substring(6));
                }
            }
        }
        return false;
    }

    public static void stop() {
        if (SERVER != null) {
            SERVER.stop(0);
            SERVER = null;
        }
    }

    /** GET /health -> {"status":"ok"} */
    private static void handleHealth(HttpExchange ex) throws IOException {
        JsonObject out = new JsonObject();
        out.addProperty("status", "ok");
        respond(ex, 200, out);
    }

    /** GET /bridge_probe -> 读当前已打开 containerMenu(窗口协议)，返回 JSON。 */
    private static void handleProbe(HttpExchange ex) throws IOException {
        if (!"GET".equals(ex.getRequestMethod())) {
            sendError(ex, 405, "use GET");
            return;
        }
        if (!checkToken(ex)) {
            sendError(ex, 401, "unauthorized: missing or bad token");
            return;
        }
        runOnClientThread(() -> {
            JsonObject out = new JsonObject();
            out.addProperty("ok", true);
            out.addProperty("client_side", true);
            Minecraft mc = Minecraft.getInstance();
            if (mc.player == null) {
                out.addProperty("error", "客户端玩家不可用");
                return out;
            }
            out.addProperty("is_inventory_menu", mc.player.containerMenu == mc.player.inventoryMenu);
            JsonObject menu = dumpMenu(mc, mc.player.containerMenu);
            if (menu == null) {
                out.addProperty("error", "当前未打开容器菜单(containerMenu 仍是玩家背包菜单)");
                out.add("menu_snapshot", new JsonObject());
            } else {
                out.add("menu", menu);
            }
            return out;
        }, ex);
    }

    /** POST /cmd -> 指令通道（预留，第二步 / 后续实现）。 */
    private static void handleCmd(HttpExchange ex) throws IOException {
        if (!checkToken(ex)) {
            sendError(ex, 401, "unauthorized: missing or bad token");
            return;
        }
        JsonObject out = new JsonObject();
        out.addProperty("ok", false);
        out.addProperty("error", "指令通道尚未实现");
        respond(ex, 501, out);
    }

    // ───────────────────────── 工具 ─────────────────────────

    /** 切到客户端主线程执行读取逻辑(读 containerMenu 必须主线程)，再把结果回给 HTTP 线程返回。 */
    private static void runOnClientThread(Supplier<JsonObject> task, HttpExchange ex) throws IOException {
        Minecraft mc = Minecraft.getInstance();
        if (!mc.isSameThread()) {
            CompletableFuture<JsonObject> future = new CompletableFuture<>();
            mc.execute(() -> {
                try {
                    future.complete(task.get());
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            });
            try {
                JsonObject result = future.get(5, TimeUnit.SECONDS);
                respond(ex, 200, result);
            } catch (Exception e) {
                JsonObject err = new JsonObject();
                err.addProperty("ok", false);
                err.addProperty("error", "主线程读取失败: " + e.getMessage());
                respond(ex, 500, err);
            }
        } else {
            respond(ex, 200, task.get());
        }
    }

    /**
     * 窗口协议核心：把 containerMenu 槽位 dump 成 JSON。
     * 容器判定：menu 就是玩家背包菜单(player.inventoryMenu)时记为 null(不算容器)。
     * 玩家背包是 36 槽 + 9 快捷 = 45 槽，不能只看槽数(会误判)。
     */
    private static JsonObject dumpMenu(Minecraft mc, AbstractContainerMenu menu) {
        if (menu == null || menu == mc.player.inventoryMenu) {
            return null; // 玩家背包菜单，不算容器
        }
        JsonObject menuJson = new JsonObject();
        menuJson.addProperty("menu_type", menu.getType().getRegistryName().toString());
        menuJson.addProperty("slot_count", menu.slots.size());
        JsonArray slots = new JsonArray();
        for (int i = 0; i < menu.slots.size(); i++) {
            Slot slot = menu.slots.get(i);
            ItemStack st = slot.getItem();
            JsonObject s = new JsonObject();
            s.addProperty("slot", i);
            s.addProperty("container", slot.container != null ? slot.container.getClass().getSimpleName() : null);
            if (!st.isEmpty()) {
                s.addProperty("item", st.getItem().getDescriptionId());
                s.addProperty("raw", st.getItem().toString());
                s.addProperty("count", st.getCount());
            } else {
                s.addProperty("item", "EMPTY");
                s.addProperty("count", 0);
            }
            slots.add(s);
        }
        menuJson.add("slots", slots);
        return menuJson;
    }

    private static void sendError(HttpExchange ex, int code, String msg) throws IOException {
        JsonObject out = new JsonObject();
        out.addProperty("ok", false);
        out.addProperty("error", msg);
        respond(ex, code, out);
    }

    private static void respond(HttpExchange ex, int code, JsonObject json) throws IOException {
        byte[] bytes = GSON.toJson(json).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }
}