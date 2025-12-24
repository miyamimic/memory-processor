/*
 * Memory Processor Extension
 * 功能：把历史记录转化为攻方视角的记忆片段
 */

import { saveSettingsDebounced } from "../../../../script.js";
import { getContext, extension_settings } from "../../../extensions.js";

const extensionName = "memory-processor";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ===== 默认设置 =====
const defaultSettings = {
    enabled: true,
    apiUrl: "",
    apiKey: "",
    model: "gpt-3.5-turbo",
    maxHistoryMessages: 50,
    memoryPrompt: `# 记忆处理器

## 你的身份
你是一个记忆处理模块。你的任务是把对话历史转化为"攻方脑子里记得的事"。

## 规则
1. 只保留攻方能感知的内容（看到的、听到的、感受到的）
2. 删除受方的内心独白（攻方看不到）
3. 用第一人称（我）
4. 带情绪色彩，不要客观中立
5. 输出短句列表，每条一个记忆片段

## 示例输出格式
- 上次在画室把他按墙上，他抖得厉害但没推开
- 他说"不行"的时候声音是软的
- 他怕我看他胸，每次都拿东西挡着`,
    cachedMemory: "",
    lastProcessedLength: 0
};

// ===== 加载设置 =====
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
}

function getSettings() {
    return extension_settings[extensionName];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ===== 格式化历史 =====
function formatHistory(chatHistory, maxMessages) {
    const recent = chatHistory.slice(-maxMessages);
    let text = "";
    for (const msg of recent) {
        if (!msg.mes || msg.mes.trim() === "") continue;
        const role = msg.is_user ? "【用户】" : "【AI】";
        text += `${role}\n${msg.mes}\n\n`;
    }
    return text;
}

// ===== 调用API（OpenAI格式兼容）=====
async function callMemoryAPI(historyText) {
    const settings = getSettings();
    
    if (!settings.apiUrl || !settings.apiKey) {
        console.error("[MemoryProcessor] API URL 或 Key 未配置");
        return null;
    }

    // OpenAI格式请求体
    const requestBody = {
        model: settings.model,
        messages: [
            {
                role: "system",
                content: settings.memoryPrompt
            },
            {
                role: "user",
                content: `以下是需要处理的对话历史：\n\n${historyText}\n\n请输出攻方视角的记忆片段：`
            }
        ],
        max_tokens: 2000,
        temperature: 0.3
    };

    try {
        const response = await fetch(settings.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("[MemoryProcessor] API错误:", response.status, errorText);
            return null;
        }

        const data = await response.json();
        
        // OpenAI格式解析
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
        
        // Claude格式兼容
        if (data.content && data.content[0] && data.content[0].text) {
            return data.content[0].text;
        }

        console.error("[MemoryProcessor] 未知响应格式:", data);
        return null;

    } catch (error) {
        console.error("[MemoryProcessor] 请求失败:", error);
        return null;
    }
}

// ===== 处理记忆 =====
async function processMemory() {
    const settings = getSettings();
    if (!settings.enabled) return null;

    const context = getContext();
    const chatHistory = context.chat;

    if (!chatHistory || chatHistory.length === 0) {
        console.log("[MemoryProcessor] 无历史记录");
        return null;
    }

    // 检查缓存
    const currentLength = chatHistory.length;
    if (settings.cachedMemory && Math.abs(currentLength - settings.lastProcessedLength) < 5) {
        console.log("[MemoryProcessor] 使用缓存");
        return settings.cachedMemory;
    }

    console.log("[MemoryProcessor] 开始处理...");
    const historyText = formatHistory(chatHistory, settings.maxHistoryMessages);
    const memory = await callMemoryAPI(historyText);

    if (memory) {
        settings.cachedMemory = memory;
        settings.lastProcessedLength = currentLength;
        saveSettings();
        console.log("[MemoryProcessor] 处理完成:\n", memory);
    }

    return memory;
}

// ===== 注入记忆 =====
function injectMemory(memory) {
    if (!memory) return;
    
    const memoryBlock = `[MEMORY_CONTEXT]
以下是你（攻方）脑子里记得的事：

${memory}

---`;
    
    window.memoryProcessorResult = memoryBlock;
    
    // 尝试设置酒馆变量
    try {
        const context = getContext();
        if (context.setExtensionPrompt) {
            context.setExtensionPrompt(extensionName, memoryBlock, 1, 0);
        }
    } catch (e) {
        console.log("[MemoryProcessor] setExtensionPrompt不可用，使用window变量");
    }
}

// ===== UI =====
const settingsHtml = `
<div id="memory_processor_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🧠 Memory Processor</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div style="padding: 10px;">
                
                <label class="checkbox_label" style="margin-bottom: 10px;">
                    <input type="checkbox" id="mp_enabled">
                    <span>启用记忆处理</span>
                </label>
                
                <hr>
                
                <label>API URL (OpenAI格式)</label>
                <input type="text" id="mp_api_url" class="text_pole" placeholder="https://your-proxy/v1/chat/completions">
                
                <label>API Key</label>
                <input type="password" id="mp_api_key" class="text_pole" placeholder="sk-...">
                
                <label>模型名称</label>
                <input type="text" id="mp_model" class="text_pole" placeholder="gpt-3.5-turbo">
                
                <label>最大历史消息数</label>
                <input type="number" id="mp_max_history" class="text_pole" value="50" min="5" max="200">
                
                <hr>
                
                <label>记忆处理Prompt</label>
                <textarea id="mp_prompt" class="text_pole" rows="8" style="font-size: 12px;"></textarea>
                
                <hr>
                
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button id="mp_test" class="menu_button">🧪 测试</button>
                    <button id="mp_clear" class="menu_button">🗑️ 清除缓存</button>
                </div>
                
                <div id="mp_status" style="margin-top: 10px; padding: 10px; border-radius: 5px; display: none; white-space: pre-wrap; font-size: 12px; max-height: 200px; overflow-y: auto;"></div>
                
            </div>
        </div>
    </div>
</div>
`;

// ===== 绑定UI事件 =====
function bindEvents() {
    const settings = getSettings();

    // 初始化UI值
    $("#mp_enabled").prop("checked", settings.enabled);
    $("#mp_api_url").val(settings.apiUrl);
    $("#mp_api_key").val(settings.apiKey);
    $("#mp_model").val(settings.model);
    $("#mp_max_history").val(settings.maxHistoryMessages);
    $("#mp_prompt").val(settings.memoryPrompt);

    // 事件绑定
    $("#mp_enabled").on("change", function() {
        settings.enabled = this.checked;
        saveSettings();
    });

    $("#mp_api_url").on("input", function() {
        settings.apiUrl = this.value.trim();
        saveSettings();
    });

    $("#mp_api_key").on("input", function() {
        settings.apiKey = this.value.trim();
        saveSettings();
    });

    $("#mp_model").on("input", function() {
        settings.model = this.value.trim();
        saveSettings();
    });

    $("#mp_max_history").on("input", function() {
        settings.maxHistoryMessages = parseInt(this.value) || 50;
        saveSettings();
    });

    $("#mp_prompt").on("input", function() {
        settings.memoryPrompt = this.value;
        saveSettings();
    });

    // 测试按钮
    $("#mp_test").on("click", async function() {
        const $status = $("#mp_status");
        $status.show().css("background", "#333").text("⏳ 正在处理...");
        
        try {
            // 强制重新处理
            settings.cachedMemory = "";
            settings.lastProcessedLength = 0;
            
            const memory = await processMemory();
            
            if (memory) {
                $status.css("background", "#1a4d1a").text("✅ 成功！\n\n" + memory);
            } else {
                $status.css("background", "#4d1a1a").text("❌ 失败，请检查控制台(F12)");
            }
        } catch (e) {
            $status.css("background", "#4d1a1a").text("❌ 错误: " + e.message);
        }
    });

    // 清除缓存按钮
    $("#mp_clear").on("click", function() {
        settings.cachedMemory = "";
        settings.lastProcessedLength = 0;
        saveSettings();
        $("#mp_status").show().css("background", "#333").text("🗑️ 缓存已清除");
    });
}

// ===== 生成前钩子 =====
async function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    console.log("[MemoryProcessor] 生成前钩子触发");
    const memory = await processMemory();
    injectMemory(memory);
}

// ===== 插件入口 =====
jQuery(async () => {
    console.log("[MemoryProcessor] 加载中...");

    loadSettings();

    // 添加UI到扩展设置区域
    $("#extensions_settings2").append(settingsHtml);
    
    bindEvents();

    // 注册生成前事件
    const { eventSource, event_types } = await import("../../../../script.js");
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    console.log("[MemoryProcessor] 加载完成 ✓");
});
