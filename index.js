/*
 * ============================================
 *  Memory Processor Extension v1.2
 * ============================================
 * 
 * 功能：
 * 1. 拦截生成请求，提取完整历史记录
 * 2. 调用记忆处理 API，转换为攻方主观视角
 * 3. 将处理后的记忆注入变量，供主预设使用
 * 4. 智能缓存，避免重复处理
 * 
 * 使用方式：
 * - 在主预设中使用 {{getvar::processed_memory}}
 * - 或在 Character Card 中使用 {{getvar::processed_memory}}
 */

import { 
    extension_settings, 
    getContext, 
    saveSettingsDebounced 
} from "../../../extensions.js";

import { 
    chat, 
    eventSource, 
    event_types
} from "../../../../script.js";

const MODULE_NAME = "memory-processor";

// 1. 初始化设置
const DEFAULT_SETTINGS = {
    enabled: true,
    apiUrl: "", 
    apiKey: "",
    model: "gpt-4o-mini",
    maxHistoryMessages: 50,
    memoryPrompt: `你是一个记忆处理器。你的任务是把角色扮演的对话历史转化为"攻方脑子里记得的事"。

## 核心原则
1. 模拟攻方的主观记忆，不是客观总结
2. 攻方只能记得他看到、听到、感受到的
3. 攻方看不到受方的内心想法
4. 记忆可以带情绪、偏差，这是正常的

## 处理规则

### ✅ 保留（攻方能感知的）
- 受方说的话（攻方听到了）
- 受方的表情、动作、身体反应（攻方看到了）
- 攻方自己做的事和感受
- 场景、地点、时间线

### ❌ 删除（攻方感知不到的）
- 受方的内心独白
- 受方的心理活动
- "他心想..."、"他暗自..."等描写

## 输出格式
用第一人称短句列表输出，每条是一个记忆碎片。
- 使用"我"而不是"攻方"
- 碎片化，不要连续段落
- 带主观情绪
- 按时间顺序

示例：
- 我记得她当时脸红了
- 我说了那句话后她沉默了很久
- 我摸她头发的时候她身体僵了一下
- 我感觉她好像在躲避我的眼神`,

    // 缓存数据
    cachedMemory: "",
    lastProcessedLength: 0
};

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
}

// 2. API 调用
async function callMemoryAPI(historyText) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.apiUrl || !settings.apiKey) return null;

    try {
        const response = await fetch(settings.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                model: settings.model,
                messages: [{
                    role: "user", 
                    content: `${settings.memoryPrompt}\n\n历史内容：\n${historyText}`
                }]
            })
        });

        const data = await response.json();
        return data.choices?.[0]?.message?.content || null;
    } catch (e) {
        console.error("[MemoryProcessor] API请求失败:", e);
        return null;
    }
}

// 3. 核心逻辑：拦截生成
async function onGenerateBefore() {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled) return;

    const context = getContext();
    const chatHistory = chat || context.chat;
    if (!chatHistory || chatHistory.length === 0) return;

    if (settings.cachedMemory && Math.abs(chatHistory.length - settings.lastProcessedLength) < 2) {
        context.setVariable("processed_memory", settings.cachedMemory);
        return;
    }

    const text = chatHistory.slice(-settings.maxHistoryMessages)
        .map(m => `${m.is_user ? '受方' : '攻方'}: ${m.mes}`).join("\n");
    
    const memory = await callMemoryAPI(text);
    if (memory) {
        settings.cachedMemory = memory;
        settings.lastProcessedLength = chatHistory.length;
        saveSettingsDebounced();
        context.setVariable("processed_memory", memory);
    }
}

// 4. 构建标准的酒馆 UI
function createUI() {
    const settings = extension_settings[MODULE_NAME];
    
    // 这是酒馆标准的折叠菜单结构
    const html = `
    <div id="memory-processor-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧠 Memory Processor (记忆预处理)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="font-size: 0.9em; padding: 10px;">
                <div class="flex-container">
                    <label class="checkbox_label">
                        <input type="checkbox" id="mp-enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>启用记忆处理</span>
                    </label>
                </div>
                
                <div class="margin-top-10">
                    <label>API URL (OpenAI兼容):</label>
                    <input type="text" id="mp-url" class="text_pole" value="${settings.apiUrl}" placeholder="https://api.xxx.com/v1/chat/completions">
                </div>
                
                <div class="margin-top-10">
                    <label>API Key:</label>
                    <input type="password" id="mp-key" class="text_pole" value="${settings.apiKey}">
                </div>
                
                <div class="margin-top-10">
                    <label>模型名称:</label>
                    <input type="text" id="mp-model" class="text_pole" value="${settings.model}">
                </div>

                <div class="margin-top-10">
                    <label>最大处理历史数:</label>
                    <input type="number" id="mp-max" class="text_pole" value="${settings.maxHistoryMessages}">
                </div>

                <div class="margin-top-10">
                    <label>自定义Prompt:</label>
                    <textarea id="mp-prompt" class="text_pole" rows="4">${settings.memoryPrompt}</textarea>
                </div>

                <div class="memory-processor-buttons margin-top-10">
                    <button id="mp-test" class="menu_button">测试并保存设置</button>
                </div>
                
                <div id="mp-status" style="margin-top:10px; opacity:0.8; font-family:monospace;">状态: 就绪</div>
            </div>
        </div>
    </div>
    `;

    $("#extensions_settings").append(html);

    // 绑定事件
    $("#mp-enabled").on("change", function() {
        settings.enabled = $(this).is(":checked");
        saveSettingsDebounced();
    });

    $("#mp-url").on("input", function() { settings.apiUrl = $(this).val(); saveSettingsDebounced(); });
    $("#mp-key").on("input", function() { settings.apiKey = $(this).val(); saveSettingsDebounced(); });
    $("#mp-model").on("input", function() { settings.model = $(this).val(); saveSettingsDebounced(); });
    $("#mp-max").on("input", function() { settings.maxHistoryMessages = parseInt($(this).val()); saveSettingsDebounced(); });
    $("#mp-prompt").on("input", function() { settings.memoryPrompt = $(this).val(); saveSettingsDebounced(); });

    $("#mp-test").on("click", async () => {
        $("#mp-status").text("状态: 正在调用测试...");
        const res = await callMemoryAPI("这是一条测试消息，用于检查API是否连通。");
        if (res) {
            $("#mp-status").html(`<span style="color:var(--green);">成功!</span><br>预览: ${res.substring(0, 50)}...`);
        } else {
            $("#mp-status").html(`<span style="color:var(--red);">失败!</span> 请检查F12控制台错误。`);
        }
    });
}

// 5. 初始化入口
jQuery(async () => {
    loadSettings();
    createUI();
    eventSource.on(event_types.GENERATION_STARTED, onGenerateBefore);
    console.log("[MemoryProcessor] 插件初始化完成");
});
