# companion-bridge 构建说明

## 目标
用 Gradle 自动下载 JDK 21 + NeoForge + Minecraft，一键产出可跑 jar。

## 前置（一次）
1. 本机需要「任一可用 JDK」（25 就行，因为 Gradle 本身用，构建产物会用自动下的 21 编译）。
2. 生成 wrapper（如果你没装 gradle，先装一个或从别处拷 gradlew，或安装 Gradle 后跑 `gradle wrapper`）。
   简单做法：安装 Gradle 8.8+（https://gradle.org/releases/），然后在此目录执行：
       gradle wrapper --gradle-version 8.10
   这会生成 gradlew.bat 和 gradle/wrapper/*。

## 路线A：自动下 JDK 21（推荐）
build.gradle 已配 toolchain.auto，wrapper 生成后直接：
       gradlew.bat build
Gradle 会自动从 foojay(Adoptium) 下载 JDK 21 编译，无需手动装。

## 路线B：手动 JDK 21（若自动下载失败，如 Adoptium 访问不了）
1. 手动装 JDK 21：https://adoptium.net/temurin/releases/  选 Windows x64 · 21
2. 装好后随便记下路径，如 C:\Program Files\Eclipse Adoptium\jdk-21.x.x
3. 构建时指定：
       gradlew.bat build -Dorg.gradle.java.home="C:\Program Files\Eclipse Adoptium\jdk-21.x.x"
   或设置环境变量 JAVA_HOME 指向该 JDK 21。

## 产出
build/libs/companion-bridge-0.1.0.jar → 拷进整合包 mods/ 目录
