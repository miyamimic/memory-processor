/*
 * Memory Processor Extension v1.1
 * 修正：API兼容性 + 时间标注
 */

import { saveSettingsDebounced } from "../../../../script.js";
import { getContext, extension_settings } from "../../../extensions.js";

const extensionName = "memory-processor";

// ===== 默认设置 =====
const defaultSettings = {
    enabled: true,
    apiUrl: "",
    apiKey: "",
    model: "gpt-3.5-turbo",
    maxHistoryMessages: 50,
    memoryPrompt: `# 记忆处理器

## 任务
把对话历史转化为攻方视角的记忆片段。

## 规则
1. 只保留攻方能感知的（看到、听到、做过）
2. 删除受方内心想法
3. 第一人称（我）
4. 每条记忆标注相对时间

## 时间标注格式
用方括号标注，例如：
[刚才] 他被我弄哭了
[今天早些] 在画室把他按墙上亲
[昨天] 他说不行但没推开
[几天前] 第一次摸到他那个地方
[更早] 刚认识的时候他躲着我

## 输出格式
每行一条记忆，带时间标注，按时间倒序（最近的在前）`,
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
    let msgIndex = 0;
    
    for (const msg of recent) {
        if (!msg.mes || msg.mes.trim() === "") continue;
        msgIndex++;
        const role = msg.is_user ? "【用户】" : "【AI】";
        // 添加消息序号，帮助AI判断时间远近
        text += `[消息${msgIndex}] ${role}\n${msg.mes}\n\n`;
    }
    
    return text;
}

// ===== 调用API =====
async function callMemoryAPI(historyText) {
    const settings = getSettings();
    
    if (!settings.apiUrl) {
        console.error("[MemoryProcessor] API URL 未配置");
        return null;
    }

    // 构建请求体 - 最简格式，兼容性最好
    const requestBody = {
        model: settings.model,
        messages: [
            {
                role: "system",
                content: settings.memoryPrompt
            },
            {
                role: "user",
                content: `对话历史（序号越大越近期）：\n\n${historyText}\n\n---\n请输出攻方视角的记忆片段，带时间标注：`
            }
        ]
    };

    // 构建headers
    const headers = {
        "Content-Type": "application/json"
    };
    
    // 只有填了key才加Authorization
    if (settings.apiKey && settings.apiKey.trim() !== "") {
        headers["Authorization"] = `Bearer ${settings.apiKey}`;
    }

    console.log("[MemoryProcessor] 发送请求到:", settings.apiUrl);
    console.log("[MemoryProcessor] 请求体:", JSON.stringify(requestBody, null, 2));

    try {
        const response = await fetch(settings.apiUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        console.log("[MemoryProcessor] 响应状态:", response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error("[MemoryProcessor] API错误:", response.status, errorText);
            throw new Error(`API返回 ${response.status}: ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
        console.log("[MemoryProcessor] 响应数据:", data);
        
        // 尝试多种格式解析
        let result = null;
        
        // OpenAI格式
        if (data.choices && data.choices[0]) {
            if (data.choices[0].message && data.choices[0].message.content) {
                result = data.choices[0].message.content;
            } else if (data.choices[0].text) {
                result = data.choices[0].text;
            }
        }
        
        // Claude格式
        if (!result && data.content && data.content[0]) {
            if (data.content[0].text) {
                result = data.content[0].text;
            }
        }
        
        // 直接content字段
        if (!result && data.content && typeof data.content === 'string') {
            result = data.content;
        }
        
        // response字段
        if (!result && data.response) {
            result = data.response;
        }

        if (!result) {
            console.error("[MemoryProcessor] 无法解析响应:", data);
            throw new Error("无法解析API响应格式");
        }

        return result;

    } catch (error) {
        console.error("[MemoryProcessor] 请求失败:", error);
        throw error;
    }
}

// ===== 处理记忆 =====
async function processMemory(forceRefresh = false) {
    const settings = getSettings();
    if (!settings.enabled) return null;

    const context = getContext();
    const chatHistory = context.chat;

    if (!chatHistory || chatHistory.length === 0) {
        console.log("[MemoryProcessor] 无历史记录");
        return null;
    }

    // 检查缓存（除非强制刷新）
    const currentLength = chatHistory.length;
    if (!forceRefresh && settings.cachedMemory && Math.abs(currentLength - settings.lastProcessedLength) < 5) {
        console.log("[MemoryProcessor] 使用缓存");
        return settings.cachedMemory;
    }

    console.log("[MemoryProcessor] 开始处理，历史消息数:", chatHistory.length);
    
    const historyText = formatHistory(chatHistory, settings.maxHistoryMessages);
    const memory = await callMemoryAPI(historyText);

    if (memory) {
        settings.cachedMemory = memory;
        settings.lastProcessedLength = currentLength;
        saveSettings();
    }

    return memory;
}

// ===== 注入记忆 =====
function injectMemory(memory) {
    if (!memory) return;
    
    const memoryBlock = `[MEMORY_CONTEXT]
# 你的记忆

以下是你（攻方）脑子里记得的事。
时间标注是相对于"现在"的。

${memory}

---`;
    
    window.memoryProcessorResult = memoryBlock;
    
    try {
        const context = getContext();
        if (context.setExtensionPrompt) {
            context.setExtensionPrompt(extensionName, memoryBlock, 1, 0);
        }
    } catch (e) {
        console.log("[MemoryProcessor] 使用window变量存储");
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
                
                <label>API URL</label>
                <small style="display:block; color:#888; margin-bottom:5px;">
                    填完整地址，例如: https://xxx.com/v1/chat/completions
                </small>
                <input type="text" id="mp_api_url" class="text_pole" placeholder="https://your-api/v1/chat/completions">
                
                <label>API Key（可选）</label>
                <small style="display:block; color:#888; margin-bottom:5px;">
                    如果反代不需要key可以留空
                </small>
                <input type="password" id="mp_api_key" class="text_pole" placeholder="sk-... 或留空">
                
                <label>模型名称</label>
                <input type="text" id="mp_model" class="text_pole" placeholder="gpt-3.5-turbo">
                
                <label>最大历史消息数</label>
                <input type="number" id="mp_max_history" class="text_pole" value="50" min="5" max="200">
                
                <hr>
                
                <label>记忆处理Prompt</label>
                <textarea id="mp_prompt" class="text_pole" rows="12" style="font-size: 12px;"></textarea>
                
                <hr>
                
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button id="mp_test" class="menu_button">🧪 测试</button>
                    <button id="mp_clear" class="menu_button">🗑️ 清缓存</button>
                    <button id="mp_copy" class="menu_button">📋 复制结果</button>
                </div>
                
                <div id="mp_status" style="margin-top: 10px; padding: 10px; border-radius: 5px; display: none; white-space: pre-wrap; font-size: 11px; max-height: 300px; overflow-y: auto; background: #222;"></div>
                
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
        const $btn = $(this);
        
        $btn.prop("disabled", true).text("⏳ 处理中...");
        $status.show().css("color", "#aaa").text("正在调用API...\n\n请查看控制台(F12)获取详细日志");
        
        try {
            const memory = await processMemory(true); // 强制刷新
            
            if (memory) {
                $status.css("color", "#8f8").text("✅ 成功！\n\n" + memory);
            } else {
                $status.css("color", "#f88").text("❌ 返回为空\n\n请检查控制台(F12)");
            }
        } catch (e) {
            $status.css("color", "#f88").text("❌ 错误:\n\n" + e.message + "\n\n请检查控制台(F12)获取详情");
        } finally {
            $btn.prop("disabled", false).text("🧪 测试");
        }
    });

    // 清除缓存按钮
    $("#mp_clear").on("click", function() {
        settings.cachedMemory = "";
        settings.lastProcessedLength = 0;
        saveSettings();
        $("#mp_status").show().css("color", "#aaa").text("🗑️ 缓存已清除");
    });
    
    // 复制结果按钮
    $("#mp_copy").on("click", function() {
        const text = $("#mp_status").text();
        if (text) {
            navigator.clipboard.writeText(text);
            $(this).text("✓ 已复制").prop("disabled", true);
            setTimeout(() => $(this).text("📋 复制结果").prop("disabled", false), 1500);
        }
    });
}

// ===== 生成前钩子 =====
async function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    console.log("[MemoryProcessor] 生成前钩子触发");
    
    try {
        const memory = await processMemory();
        injectMemory(memory);
    } catch (e) {
        console.error("[MemoryProcessor] 处理失败:", e);
    }
}

// ===== 插件入口 =====
jQuery(async () => {
    console.log("[MemoryProcessor] 加载中...");

    loadSettings();

    // 添加UI
    $("#extensions_settings2").append(settingsHtml);
    bindEvents();

    // 注册生成前事件
    try {
        const { eventSource, event_types } = await import("../../../../script.js");
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        console.log("[MemoryProcessor] 事件注册成功");
    } catch (e) {
        console.error("[MemoryProcessor] 事件注册失败:", e);
    }

    console.log("[MemoryProcessor] 加载完成 ✓");
});
