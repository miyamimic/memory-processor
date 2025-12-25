/*
 * Memory Processor Extension v1.2
 * 新增：自动注入世界书 + 完整查看窗口
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
    injectToWorldInfo: true,  // 新增：是否注入世界书
    autoUpdate: true,  // 新增：是否自动更新
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

function formatHistory(chatHistory, maxMessages) {
    const recent = chatHistory.slice(-maxMessages);
    let text = "";
    let msgIndex = 0;
    
    for (const msg of recent) {
        if (!msg.mes || msg.mes.trim() === "") continue;
        msgIndex++;
        const role = msg.is_user ? "【用户】" : "【AI】";
        text += `[消息${msgIndex}] ${role}\n${msg.mes}\n\n`;
    }
    
    return text;
}

async function callMemoryAPI(historyText) {
    const settings = getSettings();
    
    if (!settings.apiUrl) {
        throw new Error("API URL 未配置");
    }

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

    const headers = {
        "Content-Type": "application/json"
    };
    
    if (settings.apiKey && settings.apiKey.trim() !== "") {
        headers["Authorization"] = `Bearer ${settings.apiKey}`;
    }

    console.log("[MemoryProcessor] 发送请求到:", settings.apiUrl);

    const response = await fetch(settings.apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API返回 ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    
    // 多格式解析
    let result = null;
    
    if (data.choices?.[0]?.message?.content) {
        result = data.choices[0].message.content;
    } else if (data.choices?.[0]?.text) {
        result = data.choices[0].text;
    } else if (data.content?.[0]?.text) {
        result = data.content[0].text;
    } else if (typeof data.content === 'string') {
        result = data.content;
    } else if (data.response) {
        result = data.response;
    }

    if (!result) {
        throw new Error("无法解析API响应格式");
    }

    return result;
}

async function processMemory(forceRefresh = false) {
    const settings = getSettings();
    if (!settings.enabled) return null;

    const context = getContext();
    const chatHistory = context.chat;

    if (!chatHistory || chatHistory.length === 0) {
        console.log("[MemoryProcessor] 无历史记录");
        return null;
    }

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

// ===== 注入记忆到世界书 =====
async function injectMemory(memory) {
    if (!memory) return;
    
    const settings = getSettings();
    const memoryBlock = `# 你的记忆（攻方视角）

以下是你脑子里记得的事。时间标注是相对于"现在"的。

${memory}

---`;
    
    console.log("[MemoryProcessor] 准备注入记忆");
    
    // 保存到window（供手动查看）
    window.memoryProcessorResult = memoryBlock;
    
    if (!settings.injectToWorldInfo) {
        console.log("[MemoryProcessor] 世界书注入已禁用");
        return;
    }
    
    try {
        const context = getContext();
        
        // 确保世界书数组存在
        if (!context.worldInfoData) {
            context.worldInfoData = [];
        }
        
        // 查找或创建记忆条目
        let memoryEntry = context.worldInfoData.find(e => e.comment === "MEMORY_PROCESSOR_AUTO");
        
        if (!memoryEntry) {
            console.log("[MemoryProcessor] 创建新的世界书条目");
            
            memoryEntry = {
                uid: Date.now(),
                comment: "MEMORY_PROCESSOR_AUTO",
                key: [],  // 空key，依赖constant激活
                keysecondary: [],
                content: memoryBlock,
                constant: true,  // 始终激活
                selective: false,
                order: 100,
                position: 0,
                disable: false,
                excludeRecursion: false,
                probability: 100,
                useProbability: false
            };
            
            context.worldInfoData.push(memoryEntry);
        } else {
            console.log("[MemoryProcessor] 更新已有世界书条目");
            memoryEntry.content = memoryBlock;
            memoryEntry.constant = true;
            memoryEntry.disable = false;
        }
        
        // 保存世界书
        if (context.saveWorldInfo) {
            await context.saveWorldInfo();
            console.log("[MemoryProcessor] 记忆已注入世界书 ✓");
        } else {
            console.warn("[MemoryProcessor] saveWorldInfo方法不可用");
        }
        
    } catch (e) {
        console.error("[MemoryProcessor] 注入世界书失败:", e);
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
                
                <label class="checkbox_label" style="margin-bottom: 10px;">
                    <input type="checkbox" id="mp_inject_wi">
                    <span>自动注入世界书</span>
                </label>
                
                <label class="checkbox_label" style="margin-bottom: 10px;">
                    <input type="checkbox" id="mp_auto_update">
                    <span>自动更新（每次生成前）</span>
                </label>
                
                <hr>
                
                <label>API URL</label>
                <small style="display:block; color:#888; margin-bottom:5px;">
                    完整地址，例如: https://xxx.com/v1/chat/completions
                </small>
                <input type="text" id="mp_api_url" class="text_pole" placeholder="https://your-api/v1/chat/completions">
                
                <label>API Key（可选）</label>
                <input type="password" id="mp_api_key" class="text_pole" placeholder="sk-... 或留空">
                
                <label>模型名称</label>
                <input type="text" id="mp_model" class="text_pole" placeholder="gpt-3.5-turbo">
                
                <label>最大历史消息数</label>
                <input type="number" id="mp_max_history" class="text_pole" value="50" min="5" max="200">
                
                <hr>
                
                <label>记忆处理Prompt</label>
                <textarea id="mp_prompt" class="text_pole" rows="12" style="font-size: 12px;"></textarea>
                
                <hr>
                
                <div style="display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap;">
                    <button id="mp_test" class="menu_button">🧪 测试</button>
                    <button id="mp_clear" class="menu_button">🗑️ 清缓存</button>
                    <button id="mp_view_full" class="menu_button">👁️ 查看完整</button>
                    <button id="mp_copy" class="menu_button">📋 复制</button>
                </div>
                
                <div id="mp_status" style="margin-top: 10px; padding: 10px; border-radius: 5px; display: none; white-space: pre-wrap; font-size: 11px; max-height: 200px; overflow-y: auto; background: #222;"></div>
                
            </div>
        </div>
    </div>
</div>
`;

function bindEvents() {
    const settings = getSettings();

    $("#mp_enabled").prop("checked", settings.enabled);
    $("#mp_inject_wi").prop("checked", settings.injectToWorldInfo);
    $("#mp_auto_update").prop("checked", settings.autoUpdate);
    $("#mp_api_url").val(settings.apiUrl);
    $("#mp_api_key").val(settings.apiKey);
    $("#mp_model").val(settings.model);
    $("#mp_max_history").val(settings.maxHistoryMessages);
    $("#mp_prompt").val(settings.memoryPrompt);

    $("#mp_enabled").on("change", function() {
        settings.enabled = this.checked;
        saveSettings();
    });
    
    $("#mp_inject_wi").on("change", function() {
        settings.injectToWorldInfo = this.checked;
        saveSettings();
    });
    
    $("#mp_auto_update").on("change", function() {
        settings.autoUpdate = this.checked;
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
        $status.show().css("color", "#aaa").text("正在调用API...");
        
        try {
            const memory = await processMemory(true);
            
            if (memory) {
                await injectMemory(memory);
                $status.css("color", "#8f8").text("✅ 成功！已注入世界书\n\n" + memory.substring(0, 300) + (memory.length > 300 ? "\n\n..." : ""));
            } else {
                $status.css("color", "#f88").text("❌ 返回为空");
            }
        } catch (e) {
            $status.css("color", "#f88").text("❌ 错误:\n\n" + e.message);
        } finally {
            $btn.prop("disabled", false).text("🧪 测试");
        }
    });

    // 清除缓存
    $("#mp_clear").on("click", function() {
        settings.cachedMemory = "";
        settings.lastProcessedLength = 0;
        saveSettings();
        $("#mp_status").show().css("color", "#aaa").text("🗑️ 缓存已清除");
    });
    
    // 查看完整记忆
    $("#mp_view_full").on("click", function() {
        const memory = settings.cachedMemory;
        
        if (!memory) {
            alert("暂无缓存的记忆，请先点击测试");
            return;
        }
        
        const modal = $(`
            <div class="mp-modal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 9999; display: flex; align-items: center; justify-content: center;">
                <div style="background: #1a1a1a; padding: 20px; border-radius: 10px; max-width: 800px; max-height: 80vh; overflow-y: auto; position: relative;">
                    <div style="position: sticky; top: 0; background: #1a1a1a; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid #444; display: flex; justify-content: space-between; align-items: center; z-index: 1;">
                        <h3 style="margin: 0;">🧠 完整记忆</h3>
                        <div>
                            <button class="mp-modal-copy menu_button" style="margin-right: 10px;">📋 复制</button>
                            <button class="mp-modal-close menu_button">✕ 关闭</button>
                        </div>
                    </div>
                    <pre style="white-space: pre-wrap; font-size: 13px; line-height: 1.6; color: #ddd; margin: 0;">${memory}</pre>
                </div>
            </div>
        `);
        
        $("body").append(modal);
        
        modal.find(".mp-modal-close").on("click", () => modal.remove());
        modal.find(".mp-modal-copy").on("click", function() {
            navigator.clipboard.writeText(memory);
            $(this).text("✓ 已复制");
            setTimeout(() => $(this).text("📋 复制"), 1500);
        });
        modal.on("click", function(e) {
            if (e.target === this) modal.remove();
        });
    });
    
    // 复制结果
    $("#mp_copy").on("click", function() {
        const text = settings.cachedMemory;
        if (text) {
            navigator.clipboard.writeText(text);
            $(this).text("✓ 已复制").prop("disabled", true);
            setTimeout(() => $(this).text("📋 复制").prop("disabled", false), 1500);
        }
    });
}

// ===== 生成前钩子 =====
async function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoUpdate) return;
    
    console.log("[MemoryProcessor] 自动更新触发");
    
    try {
        const memory = await processMemory();
        if (memory) {
            await injectMemory(memory);
        }
    } catch (e) {
        console.error("[MemoryProcessor] 自动更新失败:", e);
    }
}

// ===== 插件入口 =====
jQuery(async () => {
    console.log("[MemoryProcessor] 加载中...");

    loadSettings();
    $("#extensions_settings2").append(settingsHtml);
    bindEvents();

    try {
        const { eventSource, event_types } = await import("../../../../script.js");
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        console.log("[MemoryProcessor] 事件注册成功");
    } catch (e) {
        console.error("[MemoryProcessor] 事件注册失败:", e);
    }

    console.log("[MemoryProcessor] 加载完成 ✓");
});
