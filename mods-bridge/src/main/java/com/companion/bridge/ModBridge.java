package com.companion.bridge;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.bus.api.SubscribeEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.companion.bridge.cmd.BridgeProbeCommand;

@Mod(ModBridge.ID)
public final class ModBridge {
    public static final String ID = "companion-bridge";
    public static final Logger LOGGER = LoggerFactory.getLogger(ID);

    public ModBridge(IEventBus bus) {
        LOGGER.info("[companion-bridge] 初始化……");
        bus.addListener(ModBridge::registerCommands);
        LOGGER.info("[companion-bridge] probe 命令就绪。");
    }

    @SubscribeEvent
    public static void registerCommands(RegisterCommandsEvent event) {
        BridgeProbeCommand.register(event.getDispatcher());
        LOGGER.info("[companion-bridge] /bridge_probe 命令已注册");
    }
}
