package com.companion.bridge.cmd;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

/**
 * /bridge_probe [<x> <y> <z>]
 *
 * 窗口协议版 probe（客户端侧）：
 *   读 Minecraft.getInstance().player.containerMenu 的槽位 → 返回 JSON。
 *
 * 设计要点（mods-bridge = 客户端模组，服务端不装任何东西）：
 *   - 不走 capability（capability 需服务端装模组，已否决）。
 *   - 走原版数据包：客户端通过 ContainerMenu 拿到服务端同步下来的容器槽位，客户端即可读。
 *   - 若指定 <x> <y> <z>：仅回传该坐标（占位；实际"模拟右键打开容器"的打开发包在 P1 做）。
 *   - 若未指定坐标：直接读当前已打开的 containerMenu（最贴近现场的验证路径）。
 */
public final class BridgeProbeCommand {
    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("bridge_probe")
            .requires(src -> src.hasPermission(0))
            .executes(ctx -> runCurrent(ctx.getSource()))
            .then(Commands.argument("x", IntegerArgumentType.integer())
                .then(Commands.argument("y", IntegerArgumentType.integer())
                    .then(Commands.argument("z", IntegerArgumentType.integer())
                        .executes(ctx -> runAt(
                            ctx.getSource(),
                            IntegerArgumentType.getInteger(ctx, "x"),
                            IntegerArgumentType.getInteger(ctx, "y"),
                            IntegerArgumentType.getInteger(ctx, "z")
                        ))
                    )
                )
            )
        );
    }

    /** 不指定坐标：读当前打开的 containerMenu（最直接的窗口协议验证）。 */
    private static int runCurrent(CommandSourceStack src) throws CommandSyntaxException {
        JsonObject out = new JsonObject();
        out.addProperty("mode", "current_menu");
        out.addProperty("client_side", true);
        out.addProperty("player", src.getPlayerOrException().getName().getString());

        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) {
            out.addProperty("error", "客户端玩家不可用");
            src.sendSuccess(() -> net.minecraft.network.chat.Component.literal(
                "bridge_probe: " + new Gson().toJson(out)), false);
            return 1;
        }

        AbstractContainerMenu menu = mc.player.containerMenu;
        JsonObject menuJson = dumpMenu(mc, menu);

        if (menuJson == null) {
            out.addProperty("error", "当前未打开可用容器菜单(containerMenu 为空/只含玩家库存)");
        } else {
            out.add("menu", menuJson);
        }

        src.sendSuccess(() -> net.minecraft.network.chat.Component.literal(
            "bridge_probe 结果:\n" + new Gson().toJson(out)), false);
        return 1;
    }

    /** 指定坐标：窗口协议打开发包在 P1 实现，此处先回传坐标 + 当前菜单状态作占位。 */
    private static int runAt(CommandSourceStack src, int x, int y, int z) throws CommandSyntaxException {
        JsonObject out = new JsonObject();
        out.addProperty("mode", "at_pos");
        out.addProperty("client_side", true);
        out.addProperty("player", src.getPlayerOrException().getName().getString());
        out.addProperty("target_pos", x + "," + y + "," + z);
        out.addProperty("note", "目标坐标点选后 '模拟右键打开容器' 的打开发包将在 P1 实现; 此处仅回传当前菜单参照");

        Minecraft mc = Minecraft.getInstance();
        JsonObject menuJson = (mc.player != null) ? dumpMenu(mc, mc.player.containerMenu) : null;
        out.add("current_menu_snapshot", menuJson == null ? new JsonObject() : menuJson);

        src.sendSuccess(() -> net.minecraft.network.chat.Component.literal(
            "bridge_probe 结果:\n" + new Gson().toJson(out)), false);
        return 1;
    }

    /**
     * 窗口协议核心：把 containerMenu 的槽位 dump 成 JSON。
     * 判定"是不是真实容器"：菜单不是玩家自己的背包菜单(inventoryMenu)才算容器，
     * 与 BridgeHttpServer 保持一致（玩家背包 45 槽不能靠槽数判定，会误判）。
     */
    private static JsonObject dumpMenu(Minecraft mc, AbstractContainerMenu menu) {
        if (menu == null || menu == mc.player.inventoryMenu) {
            return null; // 玩家自带背包菜单，不算容器
        }
        JsonObject menuJson = new JsonObject();
        menuJson.addProperty("menu_type", BuiltInRegistries.MENU.getKey(menu.getType()).toString());
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
}