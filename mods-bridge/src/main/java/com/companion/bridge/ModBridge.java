package com.companion.bridge;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.bus.api.SubscribeEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.companion.bridge.cmd.BridgeProbeCommand;
import com.companion.bridge.http.BridgeHttpServer;

@Mod(ModBridge.ID)
public final class ModBridge {
    public static final String ID = "companion-bridge";
    public static final Logger LOGGER = LoggerFactory.getLogger(ID);

    public ModBridge(IEventBus bus) {
        LOGGER.info("[companion-bridge] 初始化……");
        bus.addListener(ModBridge::registerCommands);
        // mods-bridge = 客户端模组：启动本机 HTTP 通道(零依赖, com.sun.net.httpserver)，
        // 供 TS 侧 ClientExecutionShell 查询状态 / 下发指令。
        BridgeHttpServer.start();
        LOGGER.info("[companion-bridge] probe 命令就绪, HTTP 通道已启动。");
    }

    @SubscribeEvent
    public static void registerCommands(RegisterCommandsEvent event) {
        BridgeProbeCommand.register(event.getDispatcher());
        LOGGER.info("[companion-bridge] /bridge_probe 命令已注册");
    }
}
