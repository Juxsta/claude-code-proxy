/**
 * Translates Anthropic Messages API format to Gemini generateContent format and back.
 */
const Logger = require('../Logger');

function anthropicToGemini(body, options = {}) {
  const contents = [];
  const systemInstruction = buildSystemInstruction(body.system);

  if (body.messages) {
    for (const msg of body.messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = convertContentToParts(msg.content);
      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }
  }

  const generationConfig = {};
  if (body.max_tokens) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.top_k !== undefined) generationConfig.topK = body.top_k;
  if (body.stop_sequences) generationConfig.stopSequences = body.stop_sequences;

  // Enable thinking if requested
  const thinkingConfig = {};
  if (body.thinking && body.thinking.type === 'enabled') {
    thinkingConfig.thinkingConfig = {
      thinkingBudget: body.thinking.budget_tokens || 10000
    };
  }

  const request = {
    contents,
    ...thinkingConfig,
    generationConfig
  };

  if (systemInstruction) {
    request.systemInstruction = systemInstruction;
  }

  // Disable search grounding if configured
  if (options.disableSearch !== true) {
    // Could add tool config for search here if needed
  }

  return request;
}

function buildSystemInstruction(system) {
  if (!system) return null;
  if (typeof system === 'string') {
    return { parts: [{ text: system }] };
  }
  if (Array.isArray(system)) {
    const parts = [];
    for (const block of system) {
      if (typeof block === 'string') parts.push({ text: block });
      else if (block.type === 'text') parts.push({ text: block.text });
    }
    return parts.length > 0 ? { parts } : null;
  }
  return null;
}

function convertContentToParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ text: block.text });
    } else if (block.type === 'thinking') {
      // Anthropic thinking blocks -> Gemini thought parts
      parts.push({ thought: true, text: block.thinking });
    } else if (block.type === 'tool_use') {
      parts.push({
        functionCall: {
          name: block.name,
          args: block.input || {}
        }
      });
    } else if (block.type === 'tool_result') {
      const resultParts = [];
      if (typeof block.content === 'string') {
        resultParts.push({ text: block.content });
      } else if (Array.isArray(block.content)) {
        for (const c of block.content) {
          if (c.type === 'text') resultParts.push({ text: c.text });
        }
      }
      parts.push({
        functionResponse: {
          name: block.tool_use_id || 'unknown',
          response: { content: resultParts.map(p => p.text).join('\n') }
        }
      });
    } else if (block.type === 'image') {
      if (block.source && block.source.type === 'base64') {
        parts.push({
          inlineData: {
            mimeType: block.source.media_type,
            data: block.source.data
          }
        });
      }
    }
  }
  return parts;
}

/**
 * Convert Gemini response to Anthropic Messages API format.
 */
function geminiToAnthropic(geminiResponse, model) {
  const content = [];
  let inputTokens = 0;
  let outputTokens = 0;

  if (geminiResponse.usageMetadata) {
    inputTokens = geminiResponse.usageMetadata.promptTokenCount || 0;
    outputTokens = geminiResponse.usageMetadata.candidatesTokenCount || 0;
  }

  if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
    const candidate = geminiResponse.candidates[0];
    if (candidate.content && candidate.content.parts) {
      for (const part of candidate.content.parts) {
        if (part.thought && part.text) {
          content.push({ type: 'thinking', thinking: part.text });
        } else if (part.text !== undefined) {
          content.push({ type: 'text', text: part.text });
        } else if (part.functionCall) {
          content.push({
            type: 'tool_use',
            id: 'toolu_' + Math.random().toString(36).substr(2, 9),
            name: part.functionCall.name,
            input: part.functionCall.args || {}
          });
        }
      }
    }
  }

  const stopReason = mapStopReason(geminiResponse);

  return {
    id: 'msg_' + Math.random().toString(36).substr(2, 16),
    type: 'message',
    role: 'assistant',
    content,
    model: model || 'gemini',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

function mapStopReason(geminiResponse) {
  if (!geminiResponse.candidates || geminiResponse.candidates.length === 0) return 'end_turn';
  const reason = geminiResponse.candidates[0].finishReason;
  switch (reason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY': return 'end_turn';
    case 'RECITATION': return 'end_turn';
    default: return 'end_turn';
  }
}

/**
 * Convert Gemini streaming chunks to Anthropic SSE format.
 */
function geminiStreamToAnthropicSSE(geminiChunk, state) {
  const events = [];

  if (!state.started) {
    state.started = true;
    state.messageId = 'msg_' + Math.random().toString(36).substr(2, 16);
    state.contentIndex = 0;
    events.push('event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: state.model || 'gemini',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }) + '\n\n');
  }

  if (geminiChunk.candidates && geminiChunk.candidates.length > 0) {
    const candidate = geminiChunk.candidates[0];
    if (candidate.content && candidate.content.parts) {
      for (const part of candidate.content.parts) {
        if (part.thought && part.text) {
          // Thinking block
          if (!state.inThinking) {
            state.inThinking = true;
            events.push('event: content_block_start\ndata: ' + JSON.stringify({
              type: 'content_block_start',
              index: state.contentIndex,
              content_block: { type: 'thinking', thinking: '' }
            }) + '\n\n');
          }
          events.push('event: content_block_delta\ndata: ' + JSON.stringify({
            type: 'content_block_delta',
            index: state.contentIndex,
            delta: { type: 'thinking_delta', thinking: part.text }
          }) + '\n\n');
        } else if (part.text !== undefined) {
          // Close thinking block if open
          if (state.inThinking) {
            events.push('event: content_block_stop\ndata: ' + JSON.stringify({
              type: 'content_block_stop',
              index: state.contentIndex
            }) + '\n\n');
            state.contentIndex++;
            state.inThinking = false;
          }
          // Text block
          if (!state.inText) {
            state.inText = true;
            events.push('event: content_block_start\ndata: ' + JSON.stringify({
              type: 'content_block_start',
              index: state.contentIndex,
              content_block: { type: 'text', text: '' }
            }) + '\n\n');
          }
          events.push('event: content_block_delta\ndata: ' + JSON.stringify({
            type: 'content_block_delta',
            index: state.contentIndex,
            delta: { type: 'text_delta', text: part.text }
          }) + '\n\n');
        } else if (part.functionCall) {
          // Close any open blocks
          if (state.inText || state.inThinking) {
            events.push('event: content_block_stop\ndata: ' + JSON.stringify({
              type: 'content_block_stop',
              index: state.contentIndex
            }) + '\n\n');
            state.contentIndex++;
            state.inText = false;
            state.inThinking = false;
          }
          const toolId = 'toolu_' + Math.random().toString(36).substr(2, 9);
          events.push('event: content_block_start\ndata: ' + JSON.stringify({
            type: 'content_block_start',
            index: state.contentIndex,
            content_block: { type: 'tool_use', id: toolId, name: part.functionCall.name, input: {} }
          }) + '\n\n');
          events.push('event: content_block_delta\ndata: ' + JSON.stringify({
            type: 'content_block_delta',
            index: state.contentIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args || {}) }
          }) + '\n\n');
          events.push('event: content_block_stop\ndata: ' + JSON.stringify({
            type: 'content_block_stop',
            index: state.contentIndex
          }) + '\n\n');
          state.contentIndex++;
        }
      }
    }

    // Final chunk with finish reason
    if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
      if (state.inText || state.inThinking) {
        events.push('event: content_block_stop\ndata: ' + JSON.stringify({
          type: 'content_block_stop',
          index: state.contentIndex
        }) + '\n\n');
        state.inText = false;
        state.inThinking = false;
      }

      const usage = geminiChunk.usageMetadata || {};
      events.push('event: message_delta\ndata: ' + JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: mapStopReason(geminiChunk), stop_sequence: null },
        usage: { output_tokens: usage.candidatesTokenCount || 0 }
      }) + '\n\n');
      events.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
  }

  return events.join('');
}

module.exports = {
  anthropicToGemini,
  geminiToAnthropic,
  geminiStreamToAnthropicSSE
};
