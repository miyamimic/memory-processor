import { 
    extension_settings, 
    getContext, 
    saveSettingsDebounced 
} from "../../extensions.js"; // 修正路径

import { 
    eventSource, 
    event_types
} from "../../script.js"; // 修正路径

import { 
    addExtensionControls,
    registerExtension
} from "../../extensions.js";

const MODULE_NAME = "memory-processor";

// 1. 初始化设置
const DEFAULT_SETTINGS = {
    enabled: true,
    apiUrl: "", 
    apiKey: "",
    model: "gpt-4o-mini",
    maxHistoryMessages: 50,
    memoryPrompt: `你是一个记忆处理器。你的任务是把角色扮演的对话历史转化为"攻方脑子里记得的事"。...`, // 你的 Prompt 保持不变
    cachedMemory: "",
    lastProcessedLength: 0
};

// 确保设置被加载
function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    // 合并缺失的默认值
    for (const key in DEFAULT_SETTINGS) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
}

// 2. API 调用
async function callMemoryAPI(historyText) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.apiUrl || !settings.apiKey) {
        console.warn("[MemoryProcessor] API URL 或 Key 未设置");
        return null;
    }

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
    const chatHistory = context.chat; // 从 context 获取最新 chat
    
    if (!chatHistory || chatHistory.length === 0) return;

    // 缓存机制：如果历史长度变化不大，且已有缓存，则直接利用
    if (settings.cachedMemory && Math.abs(chatHistory.length - settings.lastProcessedLength) < 1) {
        // 注入变量给主提示词使用
        context.variables["processed_memory"] = settings.cachedMemory;
        return;
    }

    const text = chatHistory.slice(-settings.maxHistoryMessages)
        .map(m => `${m.is_user ? '受方' : '攻方'}: ${m.mes}`).join("\n");
    
    const memory = await callMemoryAPI(text);
    if (memory) {
        settings.cachedMemory = memory;
        settings.lastProcessedLength = chatHistory.length;
        saveSettingsDebounced();
        // 核心：注入到酒馆的变量池
        context.variables["processed_memory"] = memory;
        console.log("[MemoryProcessor] 记忆已更新并存入变量 {{getvar::processed_memory}}");
    }
}

// 4. 构建标准的酒馆 UI (使用 addExtensionControls)
function setupUI() {
    const settings = extension_settings[MODULE_NAME];
    
    // 移除 inline-drawer 等包装，因为 addExtensionControls 会自动帮你包装
    const html = `
    <div class="memory-processor-settings">
        <div class="flex-container">
            <label class="checkbox_label">
                <input type="checkbox" id="mp-enabled" ${settings.enabled ? 'checked' : ''}>
                <span>启用记忆处理</span>
            </label>
        </div>
        
        <div class="margin-top-10">
            <label>API URL:</label>
            <input type="text" id="mp-url" class="text_pole" value="${settings.apiUrl || ''}" placeholder="https://api.xxx.com/v1/chat/completions">
        </div>
        
        <div class="margin-top-10">
            <label>API Key:</label>
            <input type="password" id="mp-key" class="text_pole" value="${settings.apiKey || ''}">
        </div>
        
        <div class="margin-top-10">
            <label>模型名称:</label>
            <input type="text" id="mp-model" class="text_pole" value="${settings.model || ''}">
        </div>

        <div class="margin-top-10">
            <label>最大处理历史数:</label>
            <input type="number" id="mp-max" class="text_pole" value="${settings.maxHistoryMessages}">
        </div>

        <div class="margin-top-10">
            <label>自定义Prompt:</label>
            <textarea id="mp-prompt" class="text_pole" rows="4">${settings.memoryPrompt}</textarea>
        </div>

        <div class="margin-top-10">
            <button id="mp-test" class="menu_button">测试并保存设置</button>
        </div>
        
        <div id="mp-status" style="margin-top:10px; opacity:0.8; font-family:monospace; font-size:10px;">状态: 就绪</div>
    </div>
    `;

    // 关键：调用酒馆原生 API 注册面板
    addExtensionControls(html, "Memory Processor", () => {
        // 绑定事件逻辑
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
            const res = await callMemoryAPI("这是一条测试消息。");
            if (res) {
                $("#mp-status").html(`<span style="color:var(--green);">成功!</span><br>预览: ${res.substring(0, 30)}...`);
            } else {
                $("#mp-status").html(`<span style="color:var(--red);">失败!</span> 请检查API配置或控制台。`);
            }
        });
    }, "fas fa-brain");
}

// 5. 初始化入口
(function() {
    loadSettings();
    registerExtension(MODULE_NAME);
    setupUI();
    eventSource.on(event_types.GENERATION_STARTED, onGenerateBefore);
    console.log("[MemoryProcessor] 插件加载成功");
})();
